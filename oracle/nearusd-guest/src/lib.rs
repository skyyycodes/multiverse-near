//! The NEAR/USD reference the contract stores: the median of four public
//! exchange prices, computed with integers only.
//!
//! stdin:  `{"min_sources":3,"max_spread_bps":200}`
//! stdout: `{"price_wad":"3502350000000000000","observed_at":1794590854,
//!          "sources_used":4,"spread_bps":78,"evidence":"coinbase=3.5047 ..."}`
//!
//! Sources, in this order: Coinbase Exchange (`price`, `time`), Kraken (the
//! last trade `c[0]`; no time, so the guest's clock), Gemini (`last`,
//! `volume.timestamp` in ms) and CoinGecko (`near.usd`, `near.last_updated_at`).
//! Each decimal is parsed into an 18-decimal integer (digits past the 18th
//! are dropped), never a float.
//!
//! The rule, which `scripts/lib/spot.ts` mirrors on the shared
//! `tests/vectors.json`:
//! - fewer than `min_sources` answers: no price;
//! - the median of the answers (the floor of the mean of the two middle
//!   values when their number is even) and
//!   `spread_bps = ceil((max - min) * 10,000 / median)`;
//! - a spread above `max_spread_bps` with more than `min_sources` answers
//!   drops the one value farthest from the median (the higher one on a tie)
//!   and computes both once more; still too wide: no price;
//! - `observed_at` is the oldest time among the sources used.
//!
//! The guest never fails on purpose: any problem becomes `"price_wad":null`
//! with the reason as evidence, so the contract stores nothing and logs it.

use serde::{Deserialize, Serialize, Serializer};
use serde_json::value::RawValue;
use serde_json::Value;

pub const WAD: u128 = 1_000_000_000_000_000_000;
const DECIMALS: usize = 18;
/// Keeps the whole output under OutLayer's 1 KiB single-call result.
pub const MAX_EVIDENCE: usize = 480;
/// The spread when it does not fit: always above any limit.
const SPREAD_OVERFLOW: u32 = u32::MAX;

/// A price source, in the order the guest asks them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Coinbase,
    Kraken,
    Gemini,
    Coingecko,
}

pub const SOURCES: [Source; 4] = [
    Source::Coinbase,
    Source::Kraken,
    Source::Gemini,
    Source::Coingecko,
];

impl Source {
    pub fn name(self) -> &'static str {
        match self {
            Source::Coinbase => "coinbase",
            Source::Kraken => "kraken",
            Source::Gemini => "gemini",
            Source::Coingecko => "coingecko",
        }
    }

    pub fn authority(self) -> &'static str {
        match self {
            Source::Coinbase => "api.exchange.coinbase.com",
            Source::Kraken => "api.kraken.com",
            Source::Gemini => "api.gemini.com",
            Source::Coingecko => "api.coingecko.com",
        }
    }

    pub fn path_with_query(self) -> &'static str {
        match self {
            Source::Coinbase => "/products/NEAR-USD/ticker",
            Source::Kraken => "/0/public/Ticker?pair=NEARUSD",
            Source::Gemini => "/v1/pubticker/nearusd",
            Source::Coingecko => {
                "/api/v3/simple/price?ids=near&vs_currencies=usd&include_last_updated_at=true"
            }
        }
    }

    pub fn url(self) -> String {
        format!("https://{}{}", self.authority(), self.path_with_query())
    }
}

/// One source's answer: the price as printed, in WAD, and when it was
/// observed (seconds).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Quote {
    pub source: Source,
    pub raw: String,
    pub price_wad: u128,
    pub observed_at: u64,
}

/// The guest's input.
#[derive(Deserialize, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub min_sources: u8,
    pub max_spread_bps: u32,
}

/// What the guest prints; `price_wad` is a decimal string or null.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Output {
    #[serde(serialize_with = "decimal_or_null")]
    pub price_wad: Option<u128>,
    pub observed_at: u64,
    pub sources_used: u8,
    pub spread_bps: u32,
    pub evidence: String,
}

fn decimal_or_null<S: Serializer>(value: &Option<u128>, s: S) -> Result<S::Ok, S::Error> {
    match value {
        Some(v) => s.serialize_str(&v.to_string()),
        None => s.serialize_none(),
    }
}

/// An accepted median.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reading {
    pub price_wad: u128,
    pub observed_at: u64,
    pub sources_used: u8,
    pub spread_bps: u32,
    /// The source left out to bring the spread within the limit.
    pub dropped: Option<Source>,
}

/// Why there is no median.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub note: String,
    pub sources_used: u8,
    pub spread_bps: u32,
}

/// A decimal string ("3.5047", "4", "4.") as an 18-decimal integer, rounded
/// down past the 18th decimal. No sign, exponent, spaces or empty parts.
pub fn parse_decimal_wad(s: &str) -> Result<u128, String> {
    let bad = || format!("not a decimal: {s}");
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, f),
        None => (s, ""),
    };
    let digits = |p: &str| p.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty() || !digits(whole) || !digits(frac) {
        return Err(bad());
    }
    let whole: u128 = whole.parse().map_err(|_| bad())?;
    let kept = &frac[..frac.len().min(DECIMALS)];
    let mut frac_wad: u128 = if kept.is_empty() {
        0
    } else {
        kept.parse().map_err(|_| bad())?
    };
    for _ in kept.len()..DECIMALS {
        frac_wad *= 10;
    }
    whole
        .checked_mul(WAD)
        .and_then(|w| w.checked_add(frac_wad))
        .ok_or_else(bad)
}

/// A WAD amount as a decimal without trailing zeros ("3.50235", "4").
pub fn format_wad(value: u128) -> String {
    let whole = value / WAD;
    let frac = value % WAD;
    if frac == 0 {
        return whole.to_string();
    }
    let frac = format!("{frac:018}");
    format!("{whole}.{}", frac.trim_end_matches('0'))
}

/// `YYYY-MM-DDTHH:MM:SS[.fraction](Z|+00:00)` as Unix seconds (the fraction
/// is dropped). Only UTC is accepted.
pub fn parse_utc_time(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<u64> {
        let part = s.get(from..to)?;
        if !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (year, month, day) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hour, minute, second) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let mut rest = &s[19..];
    if let Some(frac) = rest.strip_prefix('.') {
        let end = frac
            .bytes()
            .position(|c| !c.is_ascii_digit())
            .unwrap_or(frac.len());
        if end == 0 {
            return None;
        }
        rest = &frac[end..];
    }
    if rest != "Z" && rest != "+00:00" {
        return None;
    }
    if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let days = days_from_civil(year, month, day)?;
    Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

fn days_in_month(year: u64, month: u64) -> u64 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days from 1970-01-01 (Howard Hinnant's algorithm); None before 1970.
fn days_from_civil(year: u64, month: u64, day: u64) -> Option<u64> {
    let y = i64::try_from(year).ok()? - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::try_from(month).ok()?;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + i64::try_from(day).ok()? - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    u64::try_from(era * 146_097 + doe - 719_468).ok()
}

#[derive(Deserialize)]
struct CoinbaseTicker {
    price: String,
    time: String,
}

#[derive(Deserialize)]
struct KrakenTicker {
    error: Vec<Value>,
    /// Absent when Kraken answers with an error.
    #[serde(default)]
    result: serde_json::Map<String, Value>,
}

#[derive(Deserialize)]
struct GeminiTicker {
    last: String,
    volume: GeminiVolume,
}

#[derive(Deserialize)]
struct GeminiVolume {
    timestamp: u64,
}

#[derive(Deserialize)]
struct CoingeckoPrices<'a> {
    #[serde(borrow)]
    near: CoingeckoNear<'a>,
}

#[derive(Deserialize)]
struct CoingeckoNear<'a> {
    /// Kept as the literal JSON text: CoinGecko prints a number, which must
    /// never pass through a float.
    #[serde(borrow)]
    usd: &'a RawValue,
    last_updated_at: u64,
}

/// One source's response body as a quote. Kraken prints no time, so its
/// quote is observed `now`.
pub fn parse_quote(source: Source, body: &str, now: u64) -> Result<Quote, String> {
    let json = |e: serde_json::Error| format!("bad response: {e}");
    let (raw, observed_at) = match source {
        Source::Coinbase => {
            let t: CoinbaseTicker = serde_json::from_str(body).map_err(json)?;
            let at = parse_utc_time(&t.time).ok_or_else(|| format!("bad time: {}", t.time))?;
            (t.price, at)
        }
        Source::Kraken => {
            let t: KrakenTicker = serde_json::from_str(body).map_err(json)?;
            if !t.error.is_empty() {
                return Err(format!("error: {}", Value::Array(t.error)));
            }
            let pair = match t.result.get("NEARUSD") {
                Some(p) => p,
                None if t.result.len() == 1 => t.result.values().next().unwrap_or(&Value::Null),
                None => return Err("no NEARUSD pair".to_string()),
            };
            let last = pair["c"][0]
                .as_str()
                .ok_or_else(|| "no last trade".to_string())?;
            (last.to_string(), now)
        }
        Source::Gemini => {
            let t: GeminiTicker = serde_json::from_str(body).map_err(json)?;
            (t.last, t.volume.timestamp / 1_000)
        }
        Source::Coingecko => {
            let t: CoingeckoPrices = serde_json::from_str(body).map_err(json)?;
            (t.near.usd.get().to_string(), t.near.last_updated_at)
        }
    };
    let price_wad = parse_decimal_wad(&raw)?;
    if price_wad == 0 {
        return Err(format!("zero price: {raw}"));
    }
    Ok(Quote {
        source,
        raw,
        price_wad,
        observed_at,
    })
}

/// The median of sorted values: the middle one, or the floor of the mean of
/// the two middle ones.
fn median(sorted: &[u128]) -> u128 {
    let n = sorted.len();
    if n % 2 == 1 {
        return sorted[n / 2];
    }
    let (a, b) = (sorted[n / 2 - 1], sorted[n / 2]);
    a / 2 + b / 2 + (a % 2 + b % 2) / 2
}

/// `ceil((max - min) * 10,000 / median)` of sorted values, saturating.
fn spread_bps(sorted: &[u128], median: u128) -> u32 {
    let (Some(min), Some(max)) = (sorted.first(), sorted.last()) else {
        return 0;
    };
    if median == 0 {
        return SPREAD_OVERFLOW;
    }
    let Some(scaled) = (max - min).checked_mul(10_000) else {
        return SPREAD_OVERFLOW;
    };
    u32::try_from(scaled.div_ceil(median)).unwrap_or(SPREAD_OVERFLOW)
}

/// The median rule over the sources that answered.
pub fn aggregate(
    quotes: &[Quote],
    min_sources: u8,
    max_spread_bps: u32,
) -> Result<Reading, Refusal> {
    let n = quotes.len();
    let count = u8::try_from(n).unwrap_or(u8::MAX);
    if n < usize::from(min_sources) || n == 0 {
        return Err(Refusal {
            note: format!("too few sources ({n} < {min_sources})"),
            sources_used: count,
            spread_bps: 0,
        });
    }
    let mut used: Vec<&Quote> = quotes.iter().collect();
    used.sort_by_key(|q| q.price_wad);
    let prices = |used: &[&Quote]| used.iter().map(|q| q.price_wad).collect::<Vec<_>>();
    let mut sorted = prices(&used);
    let mut mid = median(&sorted);
    let mut spread = spread_bps(&sorted, mid);
    let mut dropped = None;
    if spread > max_spread_bps && n > usize::from(min_sources) {
        // Farthest from the median; on a tie the higher one, which sorts last.
        let mut far = 0;
        for (i, p) in sorted.iter().enumerate() {
            if p.abs_diff(mid) >= sorted[far].abs_diff(mid) {
                far = i;
            }
        }
        dropped = Some(used.remove(far).source);
        sorted = prices(&used);
        mid = median(&sorted);
        spread = spread_bps(&sorted, mid);
    }
    let sources_used = u8::try_from(used.len()).unwrap_or(u8::MAX);
    if spread > max_spread_bps {
        return Err(Refusal {
            note: format!("spread {spread} bps above {max_spread_bps}"),
            sources_used,
            spread_bps: spread,
        });
    }
    Ok(Reading {
        price_wad: mid,
        observed_at: used.iter().map(|q| q.observed_at).min().unwrap_or(0),
        sources_used,
        spread_bps: spread,
        dropped,
    })
}

/// Reads the input, asks every source through `fetch` (which returns the
/// response body), and computes the reading. `now` is the guest's clock.
pub fn run(raw_input: &str, now: u64, fetch: impl Fn(Source) -> Result<String, String>) -> Output {
    let refuse = |evidence: String, sources_used: u8, spread_bps: u32| Output {
        price_wad: None,
        observed_at: now,
        sources_used,
        spread_bps,
        evidence: clip(evidence, MAX_EVIDENCE),
    };
    let input: Input = match serde_json::from_str(raw_input) {
        Ok(input) => input,
        Err(e) => return refuse(format!("bad input: {e}"), 0, 0),
    };
    if input.min_sources == 0 || usize::from(input.min_sources) > SOURCES.len() {
        return refuse("bad input: min_sources must be 1 to 4".into(), 0, 0);
    }
    if input.max_spread_bps == 0 || input.max_spread_bps > 10_000 {
        return refuse("bad input: max_spread_bps must be 1 to 10000".into(), 0, 0);
    }
    let mut quotes = Vec::new();
    let mut parts = Vec::new();
    for source in SOURCES {
        match fetch(source).and_then(|body| parse_quote(source, &body, now)) {
            Ok(q) => {
                parts.push(format!("{}={}", source.name(), q.raw));
                quotes.push(q);
            }
            Err(e) => parts.push(format!("{}: {}", source.name(), clip(e, 80))),
        }
    }
    let sources = parts.join(" ");
    match aggregate(&quotes, input.min_sources, input.max_spread_bps) {
        Ok(r) => {
            let mut evidence = format!("{sources} median={}", format_wad(r.price_wad));
            if let Some(d) = r.dropped {
                evidence.push_str(&format!(" dropped={}", d.name()));
            }
            Output {
                price_wad: Some(r.price_wad),
                observed_at: r.observed_at,
                sources_used: r.sources_used,
                spread_bps: r.spread_bps,
                evidence: clip(evidence, MAX_EVIDENCE),
            }
        }
        Err(r) => refuse(
            format!("{sources}: {}", r.note),
            r.sources_used,
            r.spread_bps,
        ),
    }
}

/// `s` cut to at most `max` bytes, on a character boundary.
pub fn clip(mut s: String, max: usize) -> String {
    if s.len() > max {
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_794_590_900;

    fn quote(source: Source, raw: &str, observed_at: u64) -> Quote {
        Quote {
            source,
            raw: raw.to_string(),
            price_wad: parse_decimal_wad(raw).unwrap(),
            observed_at,
        }
    }

    /// The design's reading of 13 Nov 2026, 17:27 UTC.
    fn four() -> Vec<Quote> {
        vec![
            quote(Source::Coinbase, "3.5047", 1_794_590_854),
            quote(Source::Kraken, "3.5083", NOW),
            quote(Source::Gemini, "3.4810", 1_794_590_850),
            quote(Source::Coingecko, "3.50", 1_794_590_840),
        ]
    }

    #[test]
    fn median_of_four() {
        let r = aggregate(&four(), 3, 200).unwrap();
        assert_eq!(r.price_wad, 3_502_350_000_000_000_000);
        assert_eq!((r.sources_used, r.spread_bps, r.dropped), (4, 78, None));
        assert_eq!(format_wad(r.price_wad), "3.50235");
    }

    #[test]
    fn median_of_three_is_the_middle_value() {
        let r = aggregate(&four()[..3], 3, 200).unwrap();
        assert_eq!(r.price_wad, 3_504_700_000_000_000_000);
        assert_eq!(r.sources_used, 3);
    }

    #[test]
    fn drops_one_outlier() {
        let mut q = four();
        q[2] = quote(Source::Gemini, "3.10", 1_794_590_850);
        let r = aggregate(&q, 3, 200).unwrap();
        assert_eq!(r.dropped, Some(Source::Gemini));
        assert_eq!(r.sources_used, 3);
        // 3.50, 3.5047, 3.5083 -> the middle value.
        assert_eq!(r.price_wad, 3_504_700_000_000_000_000);
        assert_eq!(r.spread_bps, 24);
        // Gemini's time no longer counts.
        assert_eq!(r.observed_at, 1_794_590_840);
    }

    #[test]
    fn drops_at_most_once() {
        let mut q = four();
        q[2] = quote(Source::Gemini, "3.10", 1_794_590_850);
        q[3] = quote(Source::Coingecko, "3.90", 1_794_590_840);
        let e = aggregate(&q, 3, 200).unwrap_err();
        assert!(
            e.note.starts_with("spread ") && e.note.ends_with(" bps above 200"),
            "{}",
            e.note
        );
        assert_eq!(e.sources_used, 3);
    }

    #[test]
    fn refuses_two_sources() {
        let e = aggregate(&four()[..2], 3, 200).unwrap_err();
        assert_eq!(e.note, "too few sources (2 < 3)");
        assert_eq!(
            aggregate(&[], 1, 200).unwrap_err().note,
            "too few sources (0 < 1)"
        );
    }

    #[test]
    fn refuses_wide_spread() {
        // Exactly three sources: nothing may be dropped.
        let q = vec![
            quote(Source::Coinbase, "3.50", NOW),
            quote(Source::Kraken, "3.51", NOW),
            quote(Source::Gemini, "3.60", NOW),
        ];
        let e = aggregate(&q, 3, 200).unwrap_err();
        // ceil(0.10 * 10,000 / 3.51) = 285.
        assert_eq!(e.note, "spread 285 bps above 200");
        assert_eq!((e.sources_used, e.spread_bps), (3, 285));
        // The same spread passes a wider limit.
        assert_eq!(aggregate(&q, 3, 285).unwrap().spread_bps, 285);
    }

    #[test]
    fn a_tie_drops_the_higher_value() {
        let q = vec![
            quote(Source::Coinbase, "3.00", NOW),
            quote(Source::Kraken, "3.50", NOW),
            quote(Source::Gemini, "3.50", NOW),
            quote(Source::Coingecko, "4.00", NOW),
        ];
        let r = aggregate(&q, 3, 2_000).unwrap();
        assert_eq!(r.dropped, Some(Source::Coingecko));
        assert_eq!(r.price_wad, 3_500_000_000_000_000_000);
    }

    #[test]
    fn parses_decimals_without_floats() {
        assert_eq!(parse_decimal_wad("3.5047"), Ok(3_504_700_000_000_000_000));
        assert_eq!(parse_decimal_wad("4"), Ok(4 * WAD));
        assert_eq!(parse_decimal_wad("4."), Ok(4 * WAD));
        assert_eq!(parse_decimal_wad("0.000000000000000001"), Ok(1));
        // Past 18 decimals the digits are dropped.
        assert_eq!(parse_decimal_wad("1.0000000000000000019"), Ok(WAD + 1));
        assert_eq!(parse_decimal_wad("0.1"), Ok(WAD / 10));
        assert_eq!(
            parse_decimal_wad("340282366920938463463.374607431768211455"),
            Ok(u128::MAX)
        );
        for bad in [
            "", ".", ".5", "-1", "+1", "1e3", "3,5", " 3.5", "3.5 ", "1.2.3", "abc",
        ] {
            assert!(parse_decimal_wad(bad).is_err(), "{bad:?}");
        }
        assert!(parse_decimal_wad("340282366920938463464").is_err());
    }

    #[test]
    fn observed_at_is_the_oldest_source_time() {
        let r = aggregate(&four(), 3, 200).unwrap();
        assert_eq!(r.observed_at, 1_794_590_840);
    }

    #[test]
    fn utc_times() {
        assert_eq!(
            parse_utc_time("2026-11-13T17:27:34.123456Z"),
            Some(1_794_590_854)
        );
        assert_eq!(parse_utc_time("2026-11-13T17:27:34Z"), Some(1_794_590_854));
        assert_eq!(
            parse_utc_time("2026-11-13T17:27:34+00:00"),
            Some(1_794_590_854)
        );
        assert_eq!(parse_utc_time("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_utc_time("2000-01-01T00:00:00Z"), Some(946_684_800));
        assert_eq!(parse_utc_time("2024-02-29T23:59:59Z"), Some(1_709_251_199));
        assert_eq!(parse_utc_time("2100-03-01T12:00:00Z"), Some(4_107_585_600));
        for bad in [
            "2026-11-13 17:27:34Z",
            "2026-11-13T17:27:34",
            "2026-11-13T17:27:34+01:00",
            "2026-02-29T00:00:00Z",
            "2026-13-01T00:00:00Z",
            "1969-12-31T23:59:59Z",
            "2026-11-13T17:27:34.Z",
        ] {
            assert_eq!(parse_utc_time(bad), None, "{bad}");
        }
    }

    #[test]
    fn output_is_one_json_value() {
        let out = Output {
            price_wad: Some(3_502_350_000_000_000_000),
            observed_at: 1,
            sources_used: 4,
            spread_bps: 78,
            evidence: "x".into(),
        };
        assert_eq!(
            serde_json::to_string(&out).unwrap(),
            r#"{"price_wad":"3502350000000000000","observed_at":1,"sources_used":4,"spread_bps":78,"evidence":"x"}"#
        );
        let none = Output {
            price_wad: None,
            ..out
        };
        assert!(serde_json::to_string(&none)
            .unwrap()
            .starts_with(r#"{"price_wad":null,"#));
    }

    #[test]
    fn bad_input_fetches_nothing() {
        for input in [
            "",
            "{}",
            r#"{"min_sources":0,"max_spread_bps":200}"#,
            r#"{"min_sources":5,"max_spread_bps":200}"#,
            r#"{"min_sources":3,"max_spread_bps":0}"#,
            r#"{"min_sources":3,"max_spread_bps":200,"x":1}"#,
        ] {
            let out = run(input, NOW, |_| panic!("fetched on bad input {input}"));
            assert_eq!(out.price_wad, None);
            assert!(out.evidence.starts_with("bad input: "), "{}", out.evidence);
        }
    }

    #[test]
    fn long_evidence_is_clipped_on_a_char_boundary() {
        let out = run(r#"{"min_sources":3,"max_spread_bps":200}"#, NOW, |_| {
            Err("é".repeat(400))
        });
        assert!(out.evidence.len() <= MAX_EVIDENCE);
        assert_eq!(out.price_wad, None);
        assert_eq!(out.sources_used, 0);
    }
}
