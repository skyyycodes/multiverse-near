//! OutLayer guest that reports NEAR/USD: the median of Coinbase, Kraken,
//! Gemini and CoinGecko, computed with integers (see the library for the
//! rule and `README.md` for the build, the hash and the hosting).
//!
//! Build: `./build.sh` (wasm32-wasip2, written to `dist/nearusd-guest.wasm`)
//! Run:   `echo '{"min_sources":3,"max_spread_bps":200}' | wasmtime run -S http dist/nearusd-guest.wasm`

use std::io::{self, Read, Write};
use std::time::{SystemTime, UNIX_EPOCH};

use nearusd_guest::{run, Source};
use wasi::http::outgoing_handler;
use wasi::http::types::{
    Fields, IncomingResponse, Method, OutgoingBody, OutgoingRequest, RequestOptions, Scheme,
};
use wasi::io::streams::StreamError;

/// Exchanges' bot filters stall clients that send no User-Agent; curl's
/// passes everywhere (as for the FRED guest).
const USER_AGENT: &str = "curl/8.7.1";
/// Per request, for the connect, the first byte and every gap between bytes.
/// OutLayer aborts a run after two stalled requests.
const TIMEOUT_NS: u64 = 5_000_000_000;
/// A ticker is a few hundred bytes; anything far larger is not one.
const MAX_BODY: usize = 64 * 1024;

fn main() {
    let mut raw = String::new();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let output = match io::stdin().read_to_string(&mut raw) {
        Ok(_) => run(&raw, now, fetch),
        Err(e) => run(&format!("not json: {e}"), now, fetch),
    };
    let json = serde_json::to_string(&output).unwrap_or_else(|_| {
        r#"{"price_wad":null,"observed_at":0,"sources_used":0,"spread_bps":0,"evidence":"cannot encode the output"}"#.into()
    });
    // The response format is JSON, so stdout must hold exactly one value.
    let mut stdout = io::stdout().lock();
    let _ = stdout.write_all(json.as_bytes());
    let _ = stdout.flush();
}

/// One HTTPS GET; the body when the answer is 200.
fn fetch(source: Source) -> Result<String, String> {
    let headers = Fields::new();
    for (name, value) in [("User-Agent", USER_AGENT), ("Accept", "application/json")] {
        headers
            .append(&name.to_string(), &value.as_bytes().to_vec())
            .map_err(|e| format!("header: {e:?}"))?;
    }
    let request = OutgoingRequest::new(headers);
    request
        .set_method(&Method::Get)
        .map_err(|()| "method".to_string())?;
    request
        .set_scheme(Some(&Scheme::Https))
        .map_err(|()| "scheme".to_string())?;
    request
        .set_authority(Some(source.authority()))
        .map_err(|()| "authority".to_string())?;
    request
        .set_path_with_query(Some(source.path_with_query()))
        .map_err(|()| "path".to_string())?;
    let body = request.body().map_err(|()| "body".to_string())?;
    OutgoingBody::finish(body, None).map_err(|e| format!("body: {e:?}"))?;

    // A host that does not support a timeout refuses it; the request still runs.
    let options = RequestOptions::new();
    let _ = options.set_connect_timeout(Some(TIMEOUT_NS));
    let _ = options.set_first_byte_timeout(Some(TIMEOUT_NS));
    let _ = options.set_between_bytes_timeout(Some(TIMEOUT_NS));

    let future = outgoing_handler::handle(request, Some(options)).map_err(|e| format!("{e:?}"))?;
    let response = match future.get() {
        Some(result) => result,
        None => {
            future.subscribe().block();
            future.get().ok_or_else(|| "no response".to_string())?
        }
    }
    .map_err(|()| "response taken".to_string())?
    .map_err(|e| format!("{e:?}"))?;
    drop(future);
    read_body(response)
}

fn read_body(response: IncomingResponse) -> Result<String, String> {
    let status = response.status();
    if status != 200 {
        return Err(format!("HTTP {status}"));
    }
    let incoming = response.consume().map_err(|()| "body taken".to_string())?;
    let mut body = Vec::new();
    {
        // The stream is a child of the body: drop it first.
        let stream = incoming.stream().map_err(|()| "stream taken".to_string())?;
        loop {
            match stream.blocking_read(16 * 1024) {
                Ok(chunk) => {
                    body.extend_from_slice(&chunk);
                    if body.len() > MAX_BODY {
                        return Err("body too long".to_string());
                    }
                }
                Err(StreamError::Closed) => break,
                Err(e) => return Err(format!("read: {e:?}")),
            }
        }
    }
    drop(incoming);
    drop(response);
    String::from_utf8(body).map_err(|_| "the body is not UTF-8".to_string())
}
