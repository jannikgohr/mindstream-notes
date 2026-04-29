//! Serde helpers shared across modules.

use serde::{Deserialize, Deserializer};

/// Deserialize a JSON value into `Option<Option<T>>` so callers can
/// distinguish "field omitted" (outer `None`) from "field is null"
/// (outer `Some(None)`) from "field is set" (outer `Some(Some(_))`).
///
/// Plain `Option<Option<T>>` collapses `null` to a single `None`, which
/// loses the distinction we need for partial updates that may also want
/// to clear a column.
pub fn double_option<'de, T, D>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(de).map(Some)
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize, Debug)]
    struct Wrap {
        #[serde(default, deserialize_with = "double_option")]
        parent: Option<Option<String>>,
    }

    #[test]
    fn missing_field_is_outer_none() {
        let v: Wrap = serde_json::from_str("{}").unwrap();
        assert!(v.parent.is_none(), "missing field should be outer None");
    }

    #[test]
    fn null_field_is_some_none() {
        let v: Wrap = serde_json::from_str(r#"{"parent": null}"#).unwrap();
        assert_eq!(v.parent, Some(None), "null should mean clear-to-null");
    }

    #[test]
    fn string_field_is_some_some() {
        let v: Wrap = serde_json::from_str(r#"{"parent": "abc"}"#).unwrap();
        assert_eq!(v.parent, Some(Some("abc".into())));
    }
}
