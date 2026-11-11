//! JSON forms of the stored types (feature `serde`).
//!
//! JavaScript numbers lose integers above 2^53, so every 64-bit and wider value is written as a decimal string, the
//! way near-sdk's `U128` does. Reading accepts the same strings and rejects anything else.

use core::fmt;
use core::str::FromStr;

use serde::de::{self, Deserializer, Visitor};
use serde::ser::{SerializeSeq, Serializer};
use serde::{Deserialize, Serialize};

use crate::fixed::U256;

impl Serialize for U256 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for U256 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_str(DecimalVisitor::<U256>::new("a decimal string below 2^256"))
    }
}

/// Parses with `FromStr`, which for these types accepts plain decimal digits.
struct DecimalVisitor<T> {
    expecting: &'static str,
    marker: core::marker::PhantomData<T>,
}

impl<T> DecimalVisitor<T> {
    fn new(expecting: &'static str) -> Self {
        Self {
            expecting,
            marker: core::marker::PhantomData,
        }
    }
}

trait Decimal: Sized {
    fn parse_decimal(text: &str) -> Option<Self>;
}

impl Decimal for U256 {
    fn parse_decimal(text: &str) -> Option<Self> {
        // from_dec_str takes an empty string as zero; a JSON amount must have digits.
        if text.is_empty() {
            return None;
        }
        U256::from_dec_str(text).ok()
    }
}

macro_rules! decimal_via_from_str {
    ($($ty:ty),*) => {$(
        impl Decimal for $ty {
            fn parse_decimal(text: &str) -> Option<Self> {
                // FromStr also takes a leading '+', which is not a decimal string.
                if text.starts_with('+') {
                    return None;
                }
                <$ty>::from_str(text).ok()
            }
        }
    )*};
}

decimal_via_from_str!(u128, i128, i64);

impl<T: Decimal> Visitor<'_> for DecimalVisitor<T> {
    type Value = T;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.expecting)
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<T, E> {
        T::parse_decimal(value).ok_or_else(|| E::invalid_value(de::Unexpected::Str(value), &self))
    }
}

/// `u128` as a decimal string.
pub(crate) mod u128_string {
    use super::*;

    pub fn serialize<S: Serializer>(value: &u128, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(value)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u128, D::Error> {
        deserializer.deserialize_str(DecimalVisitor::<u128>::new("a decimal string below 2^128"))
    }
}

/// `i64` as a decimal string.
pub(crate) mod i64_string {
    use super::*;

    pub fn serialize<S: Serializer>(value: &i64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(value)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
        deserializer.deserialize_str(DecimalVisitor::<i64>::new("a signed 64-bit decimal string"))
    }
}

/// The swap-flow ring buffer: an array of exactly [`crate::flow::WINDOW`] signed decimal strings.
pub(crate) mod i128_window {
    use super::*;
    use crate::flow::WINDOW;

    pub fn serialize<S: Serializer>(
        values: &[i128; WINDOW],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(WINDOW))?;
        for value in values {
            seq.serialize_element(&value.to_string())?;
        }
        seq.end()
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<[i128; WINDOW], D::Error> {
        struct WindowVisitor;

        impl<'de> Visitor<'de> for WindowVisitor {
            type Value = [i128; WINDOW];

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(formatter, "an array of {WINDOW} signed decimal strings")
            }

            fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut values = [0i128; WINDOW];
                for (index, slot) in values.iter_mut().enumerate() {
                    let text: String = seq
                        .next_element()?
                        .ok_or_else(|| de::Error::invalid_length(index, &self))?;
                    *slot = i128::parse_decimal(&text).ok_or_else(|| {
                        de::Error::invalid_value(
                            de::Unexpected::Str(&text),
                            &"a signed decimal string",
                        )
                    })?;
                }
                if seq.next_element::<de::IgnoredAny>()?.is_some() {
                    return Err(de::Error::invalid_length(WINDOW + 1, &self));
                }
                Ok(values)
            }
        }

        deserializer.deserialize_seq(WindowVisitor)
    }
}

#[cfg(test)]
mod tests {
    use crate::cpmm::{Pool, Position};
    use crate::fixed::{U256, WAD};
    use crate::flow::SwapFlow;
    use crate::twap::TwapOracle;

    #[test]
    fn u256_is_a_decimal_string() {
        let value = U256::MAX;
        let json = serde_json::to_string(&value).unwrap();
        assert_eq!(
            json,
            "\"115792089237316195423570985008687907853269984665640564039457584007913129639935\""
        );
        assert_eq!(serde_json::from_str::<U256>(&json).unwrap(), value);
        assert!(serde_json::from_str::<U256>("\"\"").is_err());
        assert!(serde_json::from_str::<U256>("5").is_err());
        assert!(serde_json::from_str::<U256>("\"0x10\"").is_err());
    }

    #[test]
    fn stored_types_round_trip() {
        let mut pool = Pool::new();
        let mut lp = Position::new();
        pool.mint_initial(&mut lp, 40 * WAD, 100_000 * WAD).unwrap();
        pool.swap_exact_in(true, 2 * WAD, 3000).unwrap();
        let json = serde_json::to_value(&pool).unwrap();
        assert_eq!(json["reserve0"], "41994000000000000000");
        assert_eq!(json["fees0"], "6000000000000000");
        assert_eq!(serde_json::from_value::<Pool>(json).unwrap(), pool);
        lp.accrue(&pool);
        assert_eq!(
            serde_json::from_value::<Position>(serde_json::to_value(&lp).unwrap()).unwrap(),
            lp
        );

        let mut flow = SwapFlow::new();
        flow.record(i128::MIN);
        flow.record(i128::MAX);
        let json = serde_json::to_value(&flow).unwrap();
        assert_eq!(json["volumes"][0], i128::MIN.to_string());
        assert_eq!(json["count"], 2);
        assert_eq!(serde_json::from_value::<SwapFlow>(json).unwrap(), flow);

        let mut oracle = TwapOracle::new(1_000, -887_272);
        oracle.write(2_000_000_000, 887_272);
        let json = serde_json::to_value(&oracle).unwrap();
        assert_eq!(
            json["observations"][1]["tick_cumulative"],
            (-887_272i64 * 1_999_999_000).to_string()
        );
        assert_eq!(serde_json::from_value::<TwapOracle>(json).unwrap(), oracle);
    }

    #[test]
    fn malformed_windows_are_rejected() {
        let short = r#"{"volumes":["1","2"],"count":2}"#;
        assert!(serde_json::from_str::<SwapFlow>(short).is_err());
        let long = r#"{"volumes":["0","0","0","0","0","0","0","0","0"],"count":0}"#;
        assert!(serde_json::from_str::<SwapFlow>(long).is_err());
        let signed = r#"{"volumes":["+1","0","0","0","0","0","0","0"],"count":1}"#;
        assert!(serde_json::from_str::<SwapFlow>(signed).is_err());
    }
}
