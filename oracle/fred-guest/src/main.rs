//! OutLayer guest that resolves a FOMC event from FRED's federal funds
//! target range, by the same rule the event's text states.
//!
//! stdin:  `{"before":"2026-10-27","after":"2026-10-29"}`
//! stdout: `{"outcome":1,"evidence":"..."}` where `outcome` is 0 (CUTS),
//!         1 (HOLDS) or null (no result, so nothing is proposed).
//!
//! CUTS if both limits (DFEDTARU and DFEDTARL) are lower on `after` than on
//! `before`, HOLDS if neither is (a hike holds), no result if the two
//! disagree or FRED has no row for a date yet. Rates are compared in whole
//! basis points, never as floats.
//!
//! The guest never fails on purpose: any problem becomes a null outcome with
//! the reason as evidence, so the contract proposes nothing and the reason
//! shows up in its log.
//!
//! Build: `cargo build --release --target wasm32-wasip2`
//! Run:   `echo '{"before":"2026-10-27","after":"2026-10-29"}' | wasmtime run -S http fred-guest.wasm`

use std::io::{self, Read, Write};
use std::time::Duration;

use serde::{Deserialize, Serialize};

const FRED_CSV: &str = "https://fred.stlouisfed.org/graph/fredgraph.csv";
/// FRED's bot filter stalls a client that sends no User-Agent, or one it
/// does not recognise, until the request times out. curl's passes.
const USER_AGENT: &str = "curl/8.7.1";
const UPPER: &str = "DFEDTARU";
const LOWER: &str = "DFEDTARL";
const CUTS: u8 = 0;
const HOLDS: u8 = 1;
/// Keeps the whole output under OutLayer's 1 KiB single-call result.
const MAX_EVIDENCE: usize = 480;

#[derive(Deserialize)]
struct Input {
    before: String,
    after: String,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
struct Output {
    outcome: Option<u8>,
    evidence: String,
}

impl Output {
    fn none(evidence: impl Into<String>) -> Self {
        Self {
            outcome: None,
            evidence: evidence.into(),
        }
    }
}

/// One day's value of a series: the text FRED printed and its basis points.
struct Rate<'a> {
    text: &'a str,
    bps: u64,
}

fn main() {
    let mut raw = String::new();
    let output = match io::stdin().read_to_string(&mut raw) {
        Ok(_) => run(&raw, fetch),
        Err(e) => Output::none(format!("cannot read the input: {e}")),
    };
    let json = serde_json::to_string(&output)
        .unwrap_or_else(|_| r#"{"outcome":null,"evidence":"cannot encode the output"}"#.into());
    // The response format is JSON, so stdout must hold exactly one value.
    let mut stdout = io::stdout().lock();
    let _ = stdout.write_all(json.as_bytes());
    let _ = stdout.flush();
}

fn run(raw: &str, fetch: impl Fn(&str, &str, &str) -> Result<String, String>) -> Output {
    let input: Input = match serde_json::from_str(raw) {
        Ok(input) => input,
        Err(e) => return Output::none(format!("bad input: {e}")),
    };
    // The dates end up in the FRED URL, so only YYYY-MM-DD gets through.
    if !is_date(&input.before) || !is_date(&input.after) {
        return Output::none("bad input: dates must be YYYY-MM-DD");
    }
    if input.before >= input.after {
        return Output::none("bad input: before must be earlier than after");
    }
    let mut output = resolve(&input.before, &input.after, &fetch).unwrap_or_else(Output::none);
    clip(&mut output.evidence, MAX_EVIDENCE);
    output
}

/// Reads in the off-chain resolver's order, U(after), U(before), L(after),
/// L(before), and stops at the first failure, so both name the same reason.
fn resolve(
    before: &str,
    after: &str,
    fetch: &impl Fn(&str, &str, &str) -> Result<String, String>,
) -> Result<Output, String> {
    let upper = fetch(UPPER, before, after)?;
    let u_after = value_on(&upper, UPPER, after)?;
    let u_before = value_on(&upper, UPPER, before)?;
    let lower = fetch(LOWER, before, after)?;
    let l_after = value_on(&lower, LOWER, after)?;
    let l_before = value_on(&lower, LOWER, before)?;
    let rows = format!(
        "FRED {UPPER} {before}={} {after}={}, {LOWER} {before}={} {after}={}",
        u_before.text, u_after.text, l_before.text, l_after.text
    );
    let upper_cut = u_after.bps < u_before.bps;
    let lower_cut = l_after.bps < l_before.bps;
    if upper_cut != lower_cut {
        return Ok(Output::none(format!("{rows}: the limits disagree")));
    }
    let (outcome, name) = if upper_cut {
        (CUTS, "CUTS")
    } else {
        (HOLDS, "HOLDS")
    };
    Ok(Output {
        outcome: Some(outcome),
        evidence: format!("{rows}: {name}"),
    })
}

/// The first row that starts with `date`, second column, in basis points.
fn value_on<'a>(csv: &'a str, series: &str, date: &str) -> Result<Rate<'a>, String> {
    let row = csv
        .split('\n')
        .find(|line| line.starts_with(date))
        .ok_or_else(|| format!("FRED {series} has no value for {date}"))?;
    let text = row.split(',').nth(1).unwrap_or_default().trim();
    Ok(Rate {
        text,
        bps: to_bps(text)?,
    })
}

/// "4.00" -> 400, "3.75" -> 375, "4" -> 400. Digits past the second decimal
/// are dropped; FRED's "." for a missing value is not a rate.
fn to_bps(value: &str) -> Result<u64, String> {
    let not_a_rate = || format!("not a rate: {value}");
    let mut parts = value.trim().split('.');
    let whole = parts.next().unwrap_or_default();
    let frac = parts.next().unwrap_or_default();
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty() || !digits(whole) || !digits(frac) {
        return Err(not_a_rate());
    }
    // ASCII digits only, so slicing by bytes is safe.
    let cents: u64 = format!("{frac}00")[..2].parse().map_err(|_| not_a_rate())?;
    whole
        .parse::<u64>()
        .ok()
        .and_then(|w| w.checked_mul(100)?.checked_add(cents))
        .ok_or_else(not_a_rate)
}

fn is_date(s: &str) -> bool {
    s.len() == 10
        && s.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            _ => b.is_ascii_digit(),
        })
}

fn clip(s: &mut String, max: usize) {
    if s.len() > max {
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
    }
}

fn fetch(series: &str, from: &str, to: &str) -> Result<String, String> {
    let url = format!("{FRED_CSV}?id={series}&cosd={from}&coed={to}");
    let response = wasi_http_client::Client::new()
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "*/*")
        .connect_timeout(Duration::from_secs(10))
        .send()
        .map_err(|e| format!("FRED {series}: {e}"))?;
    let status = response.status();
    if status != 200 {
        return Err(format!("FRED {series}: HTTP {status}"));
    }
    let body = response.body().map_err(|e| format!("FRED {series}: {e}"))?;
    String::from_utf8(body).map_err(|_| format!("FRED {series}: the body is not UTF-8"))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    fn csv(series: &str, rows: &[(&str, &str)]) -> String {
        let mut out = format!("observation_date,{series}\n");
        for (date, value) in rows {
            out.push_str(&format!("{date},{value}\n"));
        }
        out
    }

    /// A FRED stand-in serving fixed CSVs and recording what was asked.
    struct Fred {
        upper: Result<String, String>,
        lower: Result<String, String>,
        asked: RefCell<Vec<String>>,
    }

    impl Fred {
        fn new(upper: &[(&str, &str)], lower: &[(&str, &str)]) -> Self {
            Self {
                upper: Ok(csv(UPPER, upper)),
                lower: Ok(csv(LOWER, lower)),
                asked: RefCell::new(Vec::new()),
            }
        }

        fn run(&self, input: &str) -> Output {
            run(input, |series, from, to| {
                self.asked
                    .borrow_mut()
                    .push(format!("{series} {from} {to}"));
                match series {
                    UPPER => self.upper.clone(),
                    LOWER => self.lower.clone(),
                    other => panic!("unexpected series {other}"),
                }
            })
        }
    }

    const OCT: &str = r#"{"before":"2026-10-27","after":"2026-10-29"}"#;

    #[test]
    fn october_2026_is_holds() {
        let fred = Fred::new(
            &[
                ("2026-10-27", "4.00"),
                ("2026-10-28", "4.00"),
                ("2026-10-29", "4.00"),
            ],
            &[
                ("2026-10-27", "3.75"),
                ("2026-10-28", "3.75"),
                ("2026-10-29", "3.75"),
            ],
        );
        assert_eq!(
            fred.run(OCT),
            Output {
                outcome: Some(HOLDS),
                evidence: "FRED DFEDTARU 2026-10-27=4.00 2026-10-29=4.00, DFEDTARL 2026-10-27=3.75 2026-10-29=3.75: HOLDS".into(),
            }
        );
        // one range request per series, upper first
        assert_eq!(
            *fred.asked.borrow(),
            vec![
                "DFEDTARU 2026-10-27 2026-10-29",
                "DFEDTARL 2026-10-27 2026-10-29"
            ]
        );
    }

    /// December 9-10, 2025: both limits fell by 25 bps.
    #[test]
    fn a_cut_of_both_limits_is_cuts() {
        let fred = Fred::new(
            &[("2025-12-09", "4.00"), ("2025-12-11", "3.75")],
            &[("2025-12-09", "3.75"), ("2025-12-11", "3.50")],
        );
        let out = fred.run(r#"{"before":"2025-12-09","after":"2025-12-11"}"#);
        assert_eq!(out.outcome, Some(CUTS));
        assert!(out.evidence.ends_with(": CUTS"), "{}", out.evidence);
    }

    /// September 15-16, 2026: a hike resolves HOLDS.
    #[test]
    fn a_hike_holds() {
        let fred = Fred::new(
            &[("2026-09-15", "3.75"), ("2026-09-17", "4.00")],
            &[("2026-09-15", "3.50"), ("2026-09-17", "3.75")],
        );
        let out = fred.run(r#"{"before":"2026-09-15","after":"2026-09-17"}"#);
        assert_eq!(out.outcome, Some(HOLDS));
    }

    #[test]
    fn limits_that_disagree_give_no_result() {
        let fred = Fred::new(
            &[("2026-10-27", "4.00"), ("2026-10-29", "3.75")],
            &[("2026-10-27", "3.75"), ("2026-10-29", "3.75")],
        );
        let out = fred.run(OCT);
        assert_eq!(out.outcome, None);
        assert_eq!(
            out.evidence,
            "FRED DFEDTARU 2026-10-27=4.00 2026-10-29=3.75, DFEDTARL 2026-10-27=3.75 2026-10-29=3.75: the limits disagree"
        );
    }

    /// Today's row appears around 13:00 UTC; before that there is no result,
    /// and the lower limit is not even fetched.
    #[test]
    fn a_missing_row_gives_no_result() {
        let fred = Fred::new(&[("2026-12-08", "4.00")], &[("2026-12-08", "3.75")]);
        let out = fred.run(r#"{"before":"2026-12-08","after":"2026-12-10"}"#);
        assert_eq!(
            out,
            Output::none("FRED DFEDTARU has no value for 2026-12-10")
        );
        assert_eq!(fred.asked.borrow().len(), 1);

        // the after row is looked up before the before row
        let fred = Fred::new(&[], &[]);
        assert_eq!(
            fred.run(OCT),
            Output::none("FRED DFEDTARU has no value for 2026-10-29")
        );
        let fred = Fred::new(
            &[("2026-10-27", "4.00"), ("2026-10-29", "4.00")],
            &[("2026-10-27", "3.75")],
        );
        assert_eq!(
            fred.run(OCT),
            Output::none("FRED DFEDTARL has no value for 2026-10-29")
        );
    }

    #[test]
    fn a_fetch_error_gives_no_result() {
        let mut fred = Fred::new(&[], &[]);
        fred.upper = Err("FRED DFEDTARU: HTTP 503".into());
        assert_eq!(fred.run(OCT), Output::none("FRED DFEDTARU: HTTP 503"));
        let mut fred = Fred::new(&[("2026-10-27", "4.00"), ("2026-10-29", "4.00")], &[]);
        fred.lower = Err("FRED DFEDTARL: connection reset".into());
        assert_eq!(
            fred.run(OCT),
            Output::none("FRED DFEDTARL: connection reset")
        );
    }

    #[test]
    fn a_missing_value_is_not_a_rate() {
        let fred = Fred::new(
            &[("2026-10-27", "4.00"), ("2026-10-29", ".")],
            &[("2026-10-27", "3.75"), ("2026-10-29", "3.75")],
        );
        assert_eq!(fred.run(OCT), Output::none("not a rate: ."));
    }

    #[test]
    fn crlf_rows_parse() {
        let mut fred = Fred::new(&[], &[]);
        fred.upper =
            Ok("observation_date,DFEDTARU\r\n2026-10-27,4.00\r\n2026-10-29,4.00\r\n".into());
        fred.lower =
            Ok("observation_date,DFEDTARL\r\n2026-10-27,3.75\r\n2026-10-29,3.75\r\n".into());
        assert_eq!(fred.run(OCT).outcome, Some(HOLDS));
    }

    #[test]
    fn bps_parsing_matches_the_resolver() {
        assert_eq!(to_bps("4.00"), Ok(400));
        assert_eq!(to_bps("3.75"), Ok(375));
        assert_eq!(to_bps("4"), Ok(400));
        assert_eq!(to_bps("4."), Ok(400));
        assert_eq!(to_bps("4.5"), Ok(450));
        assert_eq!(to_bps("0.125"), Ok(12));
        assert_eq!(to_bps(" 5.25\r"), Ok(525));
        assert_eq!(to_bps("0004.00"), Ok(400));
        // like the resolver's split, anything after a second dot is ignored
        assert_eq!(to_bps("4.00.9"), Ok(400));
        for bad in ["", ".", ".5", "-0.25", "+4", "4,00", "4.0x", "abc", "1e2"] {
            assert_eq!(to_bps(bad), Err(format!("not a rate: {bad}")), "{bad:?}");
        }
        assert_eq!(to_bps("184467440737095516.15"), Ok(u64::MAX));
        assert!(to_bps("184467440737095516.16").is_err());
        assert!(to_bps("99999999999999999999").is_err());
    }

    #[test]
    fn bad_input_gives_no_result_and_fetches_nothing() {
        for input in [
            "",
            "{}",
            r#"{"before":"2026-10-27"}"#,
            r#"{"before":"2026-10-7","after":"2026-10-29"}"#,
            r#"{"before":"2026-10-27","after":"2026-10-29&id=X"}"#,
            r#"{"before":"2026/10/27","after":"2026-10-29"}"#,
            r#"{"before":"2026-10-29","after":"2026-10-29"}"#,
            r#"{"before":"2026-10-29","after":"2026-10-27"}"#,
        ] {
            let fred = Fred::new(&[], &[]);
            let out = fred.run(input);
            assert_eq!(out.outcome, None, "{input}");
            assert!(
                out.evidence.starts_with("bad input: "),
                "{input}: {}",
                out.evidence
            );
            assert!(fred.asked.borrow().is_empty());
        }
    }

    #[test]
    fn output_is_one_json_value() {
        let holds = Output {
            outcome: Some(HOLDS),
            evidence: "x".into(),
        };
        assert_eq!(
            serde_json::to_string(&holds).unwrap(),
            r#"{"outcome":1,"evidence":"x"}"#
        );
        assert_eq!(
            serde_json::to_string(&Output::none("y")).unwrap(),
            r#"{"outcome":null,"evidence":"y"}"#
        );
    }

    #[test]
    fn long_evidence_is_clipped_on_a_char_boundary() {
        let mut fred = Fred::new(&[], &[]);
        fred.upper = Err(format!("FRED DFEDTARU: {}", "é".repeat(400)));
        let out = fred.run(OCT);
        assert!(out.evidence.len() <= MAX_EVIDENCE);
        assert!(out.evidence.len() >= MAX_EVIDENCE - 1);
    }
}
