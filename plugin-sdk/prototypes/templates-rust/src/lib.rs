//! Comparison prototype. The shipped Templates plugin remains TypeScript.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

wit_bindgen::generate!({ path: "../../wit", world: "mindstream:plugin/plugin" });
#[cfg(not(feature = "local-calendar"))]
use mindstream::plugin::clock;
use mindstream::plugin::{notes, runtime};

#[cfg(feature = "local-calendar")]
mod calendar;

fn trim(value: &str) -> &str {
    value.trim_matches(['\t', '\n', '\u{b}', '\u{c}', '\r', ' '])
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        Value::Number(n) => ryu_js::Buffer::new()
            .format(n.as_f64().expect("JSON number"))
            .into(),
        _ => value.to_string(),
    }
}

fn filter(value: String, name: &str) -> String {
    match name {
        "upper" => value.to_ascii_uppercase(),
        "lower" => value.to_ascii_lowercase(),
        "trim" => trim(&value).into(),
        "capitalize" => {
            let mut bytes = value.into_bytes();
            if let Some(first) = bytes.first_mut() {
                first.make_ascii_uppercase();
            }
            String::from_utf8(bytes).expect("ASCII conversion preserves UTF-8")
        }
        "slug" => {
            let mut out = String::new();
            let mut separator = false;
            for c in value.chars() {
                if c.is_ascii_alphanumeric() {
                    if separator && !out.is_empty() {
                        out.push('-');
                    }
                    out.push(c.to_ascii_lowercase());
                    separator = false;
                } else {
                    separator = true;
                }
            }
            out
        }
        _ => value,
    }
}

fn resolve(inner: &str, input: &Value, vars: &Value) -> Result<String, String> {
    let mut parts = inner.split('|');
    let expression = trim(parts.next().unwrap_or_default());
    let (mut base, format) = expression
        .split_once(':')
        .map_or((expression, None), |(a, b)| (trim(a), Some(trim(b))));
    let mut offsets = Vec::new();
    loop {
        let bytes = base.as_bytes();
        let Some(unit) = bytes.last().copied() else {
            break;
        };
        if !b"yMwdhms".contains(&unit) {
            break;
        }
        let mut start = bytes.len() - 1;
        while start > 0 && bytes[start - 1].is_ascii_digit() {
            start -= 1;
        }
        if start == bytes.len() - 1 || start == 0 || !b"+-".contains(&bytes[start - 1]) {
            break;
        }
        offsets.push((
            base[start - 1..bytes.len() - 1]
                .parse::<i64>()
                .map_err(|_| "invalid clock offset")?,
            unit,
        ));
        base = &base[..start - 1];
    }
    base = trim(base);
    let default = match base {
        "date" => Some("YYYY-MM-DD"),
        "time" => Some("HH:mm"),
        "datetime" | "now" => Some("YYYY-MM-DD HH:mm"),
        _ => None,
    };
    let mut value = if base == "uuid" {
        runtime::uuid()
    } else if let Some(default) = default {
        #[cfg(feature = "local-calendar")]
        let rendered = calendar::render(
            input["now"].as_str().unwrap_or_default(),
            input["timeZone"]
                .as_str()
                .ok_or("local calendar requires timeZone")?,
            offsets.into_iter().rev(),
            format.unwrap_or(default),
            input["locale"].as_str().unwrap_or("en"),
        )?;
        #[cfg(not(feature = "local-calendar"))]
        let rendered = {
            let mut time = input["now"].as_str().unwrap_or_default().to_string();
            for (count, unit) in offsets.into_iter().rev() {
                let unit = match unit {
                    b'y' => clock::TimeUnit::Year,
                    b'M' => clock::TimeUnit::Month,
                    b'w' => clock::TimeUnit::Week,
                    b'd' => clock::TimeUnit::Day,
                    b'h' => clock::TimeUnit::Hour,
                    b'm' => clock::TimeUnit::Minute,
                    _ => clock::TimeUnit::Second,
                };
                time = clock::add(&time, count, unit).map_err(|e| format!("{e:?}"))?;
            }
            clock::format(&time, format.unwrap_or(default), input["locale"].as_str())
                .map_err(|e| format!("{e:?}"))?
        };
        rendered
    } else {
        js_string(&vars[base])
    };
    for name in parts {
        value = filter(value, trim(name));
    }
    Ok(value)
}

fn render(text: &str, input: &Value, vars: &Value) -> Result<String, String> {
    let mut remaining = text;
    let mut out = String::new();
    while let Some(open) = remaining.find("{{") {
        let Some(close) = remaining[open + 2..].find("}}") else {
            break;
        };
        out.push_str(&remaining[..open]);
        out.push_str(&resolve(
            &remaining[open + 2..open + 2 + close],
            input,
            vars,
        )?);
        remaining = &remaining[open + 2 + close + 2..];
    }
    out.push_str(remaining);
    Ok(out)
}

fn under<'a>(
    mut current: Option<&'a str>,
    target: &str,
    parents: &HashMap<&'a str, Option<&'a str>>,
) -> bool {
    let mut seen = HashSet::new();
    while let Some(id) = current {
        if !seen.insert(id) {
            break;
        }
        if id == target {
            return true;
        }
        current = parents.get(id).copied().flatten();
    }
    false
}

fn menu(input: &Value) -> Result<Value, String> {
    let folder = input["settings"]["source-folder"]
        .as_str()
        .filter(|s| !s.is_empty());
    let tag = input["settings"]["source-tag"]
        .as_str()
        .filter(|s| !s.is_empty());
    if folder.is_none() && tag.is_none() {
        return Ok(
            json!({"effect":"toast","message":"Set a template folder or tag in Settings → Plugins → Templates."}),
        );
    }
    let parents: HashMap<&str, Option<&str>> = input["folders"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| Some((f["id"].as_str()?, f["parentId"].as_str())))
        .collect();
    let mut items: Vec<Value> = notes::all()
        .map_err(|e| format!("{e:?}"))?
        .iter()
        .filter(|n| {
            tag.is_some_and(|tag| n.tags.iter().any(|t| t == tag))
                || folder.is_some_and(|folder| under(n.folder_id.as_deref(), folder, &parents))
        })
        .map(|n| json!({"label":n.title,"run":{"effect":"createNoteFromNote","sourceNoteId":n.id}}))
        .collect();
    items.sort_by(|a, b| a["label"].as_str().cmp(&b["label"].as_str()));
    Ok(if items.is_empty() {
        json!({"effect":"toast","message":"No template notes found."})
    } else {
        json!({"effect":"openMenu","items":items})
    })
}

struct Templates;
impl Guest for Templates {
    fn invoke(export: String, input: String) -> Result<String, String> {
        let input: Value = serde_json::from_str(&input).map_err(|e| e.to_string())?;
        let output = match export.as_str() {
            "$exports" => json!(["newFromTemplate", "renderTemplate"]),
            "newFromTemplate" => menu(&input)?,
            "renderTemplate" => {
                let mut vars = input["vars"]
                    .as_object()
                    .cloned()
                    .map(Value::Object)
                    .unwrap_or(json!({}));
                let title = render(input["title"].as_str().unwrap_or_default(), &input, &vars)?;
                vars["title"] = json!(title);
                json!({"title":title,"body":render(input["body"].as_str().unwrap_or_default(), &input, &vars)?})
            }
            _ => return Err(format!("unknown export {export}")),
        };
        Ok(output.to_string())
    }
}
export!(Templates);

#[cfg(all(test, feature = "local-calendar"))]
#[test]
fn local_calendar_requires_a_zone_only_for_date_expressions() {
    let run = |value: Value| Templates::invoke("renderTemplate".into(), value.to_string());
    assert!(run(json!({"body":"{{date}}","now":"2026-01-01T00:00:00Z"})).is_err());
    assert!(
        run(json!({"body":"{{date}}","now":"2026-01-01T00:00:00Z","timeZone":"bad/zone"})).is_err()
    );
    let value: Value =
        serde_json::from_str(&run(json!({"body":"Hello {{name}}","vars":{"name":"Ada"}})).unwrap())
            .unwrap();
    assert_eq!(value["body"], "Hello Ada");
}
