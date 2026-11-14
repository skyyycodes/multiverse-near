# nearusd-guest

The program OutLayer runs to give the contract its outside NEAR/USD reference
(`request_reference` → `on_reference_result`). It asks four public exchanges
for the NEAR/USD price, takes the median with integers only and prints one
JSON value:

```
stdin:  {"min_sources":3,"max_spread_bps":200}
stdout: {"price_wad":"3465550000000000000","observed_at":1794614889,"sources_used":4,"spread_bps":87,"evidence":"coinbase=3.465 kraken=3.46610 gemini=3.4400 coingecko=3.47 median=3.46555"}
```

The contract builds the input from its `ReferenceConfig` and checks the result
again before storing it (sources, spread, the observation's age, bounds).

## Sources

In this order, each with a 5 s timeout (connect, first byte and every gap) and
`User-Agent: curl/8.7.1`:

| Source | URL | Price | Time |
|---|---|---|---|
| Coinbase Exchange | `https://api.exchange.coinbase.com/products/NEAR-USD/ticker` | `price` | `time` (RFC 3339, UTC) |
| Kraken | `https://api.kraken.com/0/public/Ticker?pair=NEARUSD` | `result.NEARUSD.c[0]` (last trade) | none: the guest's clock |
| Gemini | `https://api.gemini.com/v1/pubticker/nearusd` | `last` | `volume.timestamp` (ms) |
| CoinGecko | `https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd&include_last_updated_at=true` | `near.usd` (read as the literal JSON text) | `near.last_updated_at` |

A source that fails (HTTP status, timeout, unexpected body, a price that is
not a plain decimal, a zero price) is left out and named in the evidence.

## The rule

- Every price is parsed from its decimal text into an 18-decimal integer;
  digits past the 18th decimal are dropped. No floats anywhere.
- Fewer than `min_sources` answers: no price (`too few sources (n < min)`).
- The median: the middle value, or the floor of the mean of the two middle
  values when their number is even.
- `spread_bps = ceil((max - min) * 10,000 / median)`.
- A spread above `max_spread_bps` with more than `min_sources` answers drops
  the one value farthest from the median (the higher one on a tie) and
  computes the median and the spread once more. Still above: no price
  (`spread S bps above MAX`).
- `observed_at` is the oldest time among the sources used.
- No price is printed as `"price_wad":null` with the reason in `evidence`; the
  guest never fails on purpose. The output stays under 1 KiB.

`tests/vectors.json` holds the shared vectors of this rule (decimals, times,
each source's body, the median cases and whole runs); `scripts/lib/spot.ts`
reads the same file, so the scripts' seeding prices and the contract's
reference follow one rule.

## Build

```bash
cd oracle/nearusd-guest
cargo test --locked
./build.sh
```

`rust-toolchain.toml` pins Rust 1.86.0 with the `wasm32-wasip2` target (the
only kind OutLayer lets make outbound HTTPS calls). The crate is not a member
of the cargo workspace at the repository root. `build.sh` builds in the
crate's own `target/` and remaps source paths, so the same toolchain and
lockfile give the same bytes at any path (two builds at different paths gave
the same hash), then copies the file to `dist/` and prints its SHA-256:

```
6034aac8620b4559660c0315f1d4897509b6c3a722290e6c426ab50c21f52fc7  dist/nearusd-guest.wasm
```

(206,606 bytes.) `dist/nearusd-guest.wasm` is committed: it is the file the
contract pins. Rebuilding must reproduce this hash; if a change to the guest
changes it, commit the new file and the new hash here together.

## Run locally

```bash
brew install wasmtime
echo '{"min_sources":3,"max_spread_bps":200}' \
  | wasmtime run -S http dist/nearusd-guest.wasm
```

Recorded on 2026-11-14 at 00:09 UTC, wasmtime 50.0.1, against the live
sources (3.5 s; the same source before `cargo fmt`, which only moved lines):

```
{"price_wad":"3465550000000000000","observed_at":1794614889,"sources_used":4,"spread_bps":87,"evidence":"coinbase=3.465 kraken=3.46610 gemini=3.4400 coingecko=3.47 median=3.46555"}
```

And with the committed file at 00:10 UTC, when Kraken reset the connection
from this network (curl saw the same resets in between successes), the
median of the other three (1.8 s):

```
{"price_wad":"3458500000000000000","observed_at":1794614987,"sources_used":3,"spread_bps":87,"evidence":"coinbase=3.4585 kraken: ErrorCode::ConnectionTerminated gemini=3.4400 coingecko=3.47 median=3.4585"}
```

`observed_at` was 69 s and 42 s before the runs ended (CoinGecko's last
update both times), so the contract's `max_result_delay_sec` must leave room
for that lag plus OutLayer's round trip (about 15 s for the FRED guest).

## Host it at a pinned URL

The web build copies `dist/nearusd-guest.wasm` to `/outlayer/nearusd-guest.wasm`,
which is the URL staging pins. Any URL works that is `https://`, serves the
file directly (HTTP 200, no redirect) and never changes, for example a raw
file at a fixed commit of the public repository:

```bash
URL="https://raw.githubusercontent.com/skyyycodes/multiverse-near/$COMMIT/oracle/nearusd-guest/dist/nearusd-guest.wasm"
curl -sSI "$URL" | head -1        # HTTP/2 200
curl -sSf "$URL" | shasum -a 256  # must print the hash above
```

## Configure the contract

One owner call (`set_reference_config`) pins the guest and sets the checks;
`scripts/reference.ts configure` does the same. The attached NEAR pays for the
stored bytes and the rest is refunded:

```json
{"config":{"enabled":true,
  "guest":{"outlayer_id":"outlayer.testnet","wasm_url":"<url>","wasm_sha256":"<hash>",
           "resource_limits":{"max_instructions":1000000000,"max_memory_mb":128,"max_execution_seconds":30},
           "deposit":"5000000000000000000000"},
  "reporter_id":"<reporter account or null>",
  "min_sources":3,"max_spread_bps":200,"max_result_delay_sec":120,
  "borrow_max_age_sec":3600,"liquidation_max_age_sec":300,
  "min_price":"10000000000000000","max_price":"10000000000000000000000"}}
```

Bounds: `min_sources` 1-4, `max_spread_bps` 1-2,000, `max_result_delay_sec`
30-600, `borrow_max_age_sec` 300-86,400, `liquidation_max_age_sec` 60-900 and
at most `borrow_max_age_sec`, `0 < min_price < max_price <= 1e24`. A config
with `enabled: false` is always accepted.

## Refresh the reference

Anyone, from any funded account: `request_reference` with at least the
guest's deposit (0.005 NEAR by default; what the run does not use goes back to
the caller) and 300 Tgas. One request is in flight at a time; one that has
waited 600 s no longer blocks. The callback stores the price (event
`reference_updated`) or logs why not (`reference_rejected`).

## Trust

The result is computed by this pinned, open WASM inside an Intel TDX enclave,
and OutLayer publishes an attestation for every run. On-chain, OutLayer's
contract accepts the result from its operator account, so the reference is as
trustworthy as OutLayer's key custody and the four exchanges. It can lower
liquidation prices by at most a market's `max_haircut` (20% by default), and
the owner can switch it off globally (`enabled: false`) or per market at any
time.
