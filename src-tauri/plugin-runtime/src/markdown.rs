//! Markdown helpers for plugins.

use std::fmt::Write as _;

use crate::error::{HostError, HostResult};

/// A `---` delimited YAML frontmatter block from a JSON object. Scalars and
/// one level of arrays are written as YAML. Anything deeper is written as JSON
/// so nothing is silently lost.
pub fn frontmatter(value: &serde_json::Value) -> HostResult<String> {
    let obj = value
        .as_object()
        .ok_or_else(|| HostError::Invalid("frontmatter expects an object".into()))?;
    let mut out = String::from("---\n");
    for (key, val) in obj {
        match val {
            serde_json::Value::Array(items) => {
                let _ = writeln!(out, "{key}:");
                for item in items {
                    let _ = writeln!(out, "  - {}", yaml_scalar(item));
                }
            }
            other => {
                let _ = writeln!(out, "{key}: {}", yaml_scalar(other));
            }
        }
    }
    out.push_str("---\n");
    Ok(out)
}

/// One YAML scalar. Strings are double-quoted and escaped, so they are always
/// valid. Numbers and booleans are bare, and null is empty.
fn yaml_scalar(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => {
            let escaped = s
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('\n', "\\n");
            format!("\"{escaped}\"")
        }
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn writes_scalars_and_lists() {
        let fm = frontmatter(&json!({
            "title": "Hi \"there\"\nyou",
            "tags": ["a", 1, true, null],
            "draft": false,
            "count": 3,
            "none": null,
            "nested": { "a": 1 },
        }))
        .unwrap();
        assert!(fm.starts_with("---\n") && fm.ends_with("---\n"));
        assert!(fm.contains("title: \"Hi \\\"there\\\"\\nyou\"\n"), "{fm}");
        assert!(
            fm.contains("tags:\n  - \"a\"\n  - 1\n  - true\n  - \n"),
            "{fm}"
        );
        assert!(fm.contains("draft: false\n"));
        assert!(fm.contains("count: 3\n"));
        assert!(fm.contains("none: \n"));
        assert!(fm.contains("nested: {\"a\":1}\n"), "{fm}");
    }

    #[test]
    fn refuses_anything_but_an_object() {
        assert!(frontmatter(&json!([1])).is_err());
        assert!(frontmatter(&json!("x")).is_err());
    }
}
