//! Packs every date occurrence, without deduplication, into the general batch API.
use super::{expression, trim};
use crate::mindstream::plugin::{
    batch::{self, AddRequest, Command, FormatRequest, Operation, TextInput, Value as HostValue},
    clock,
};
use serde_json::{json, Value};

fn unit(u: u8) -> clock::TimeUnit {
    match u {
        b'y' => clock::TimeUnit::Year,
        b'M' => clock::TimeUnit::Month,
        b'w' => clock::TimeUnit::Week,
        b'd' => clock::TimeUnit::Day,
        b'h' => clock::TimeUnit::Hour,
        b'm' => clock::TimeUnit::Minute,
        _ => clock::TimeUnit::Second,
    }
}
fn flush(
    commands: &mut Vec<Command>,
    keys: &mut Vec<String>,
    cache: &mut serde_json::Map<String, Value>,
) -> Result<(), String> {
    if commands.is_empty() {
        return Ok(());
    }
    let replies =
        batch::execute(commands).map_err(|e| format!("batch {}: {:?}", e.index, e.cause))?;
    for (key, reply) in keys.drain(..).zip(replies) {
        if let HostValue::Text(value) = reply.value {
            cache.insert(key, json!(value));
        } else {
            return Err("batch returned non-text calendar result".into());
        }
    }
    commands.clear();
    Ok(())
}
pub fn prepare(mut input: Value) -> Result<Value, String> {
    let mut commands = Vec::new();
    let mut keys = Vec::new();
    let mut cache = serde_json::Map::new();
    for text in [
        input["title"].as_str().unwrap_or_default(),
        input["body"].as_str().unwrap_or_default(),
    ] {
        let mut remaining = text;
        while let Some(open) = remaining.find("{{") {
            let Some(close) = remaining[open + 2..].find("}}") else {
                break;
            };
            let inner = &remaining[open + 2..open + 2 + close];
            remaining = &remaining[open + 2 + close + 2..];
            let (base, pattern, offsets) = expression(inner)?;
            let default = match trim(base) {
                "date" => "YYYY-MM-DD",
                "time" => "HH:mm",
                "datetime" | "now" => "YYYY-MM-DD HH:mm",
                _ => continue,
            };
            // Unusually long expressions retain the scalar fallback instead of changing semantics.
            if offsets.len() >= 128 {
                continue;
            }
            if commands.len() + offsets.len() + 1 > 128 {
                flush(&mut commands, &mut keys, &mut cache)?;
            }
            let mut timestamp =
                TextInput::Literal(input["now"].as_str().unwrap_or_default().into());
            for (amount, u) in offsets.into_iter().rev() {
                let index = commands.len() as u32;
                commands.push(Command {
                    operation: Operation::ClockAdd(AddRequest {
                        timestamp,
                        amount,
                        unit: unit(u),
                    }),
                    keep: false,
                });
                timestamp = TextInput::Previous(index);
            }
            commands.push(Command {
                operation: Operation::ClockFormat(FormatRequest {
                    timestamp,
                    pattern: TextInput::Literal(pattern.unwrap_or(default).into()),
                    locale: input["locale"]
                        .as_str()
                        .map(|s| TextInput::Literal(s.into())),
                }),
                keep: true,
            });
            keys.push(inner.into());
        }
    }
    flush(&mut commands, &mut keys, &mut cache)?;
    input["__batch_dates"] = Value::Object(cache);
    Ok(input)
}
