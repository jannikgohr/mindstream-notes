//! Same mixed-capability plan through scalar imports or one general batch.
#[cfg(feature = "batch-host")]
use crate::mindstream::plugin::batch;
#[cfg(not(feature = "batch-host"))]
use crate::mindstream::plugin::{batch::Reply, markdown, notes, runtime, storage};
use crate::mindstream::plugin::{
    batch::{
        AddRequest, Command, FormatRequest, Operation, TextInput, Value as HostValue, WriteRequest,
    },
    clock,
};
use serde_json::{json, Value};
fn lit(s: &str) -> TextInput {
    TextInput::Literal(s.into())
}
#[cfg(not(feature = "batch-host"))]
fn get<'a>(t: &'a TextInput, values: &'a [HostValue]) -> Result<&'a str, String> {
    match t {
        TextInput::Literal(s) => Ok(s),
        TextInput::Previous(i) => match &values[*i as usize] {
            HostValue::Text(s) | HostValue::OptionalText(Some(s)) => Ok(s),
            _ => Err("no text".into()),
        },
    }
}
pub fn run(input: &Value) -> Result<Value, String> {
    let mut commands = Vec::new();
    for i in 0..4 {
        let base = commands.len() as u32;
        commands.extend([
            Command {
                operation: Operation::ClockAdd(AddRequest {
                    timestamp: lit(input["now"].as_str().unwrap_or_default()),
                    amount: i + 1,
                    unit: clock::TimeUnit::Month,
                }),
                keep: false,
            },
            Command {
                operation: Operation::ClockFormat(FormatRequest {
                    timestamp: TextInput::Previous(base),
                    pattern: lit("YYYY-MM-DD"),
                    locale: Some(lit("de")),
                }),
                keep: true,
            },
            Command {
                operation: Operation::NotesGet(lit("n0")),
                keep: true,
            },
            Command {
                operation: Operation::Frontmatter(lit(
                    "{\"title\":\"Batch probe\",\"tags\":[\"test\"]}",
                )),
                keep: true,
            },
            Command {
                operation: Operation::HasPermission(lit("notes.read")),
                keep: true,
            },
            Command {
                operation: Operation::StorageWrite(WriteRequest {
                    path: lit("batch-probe.txt"),
                    contents: TextInput::Previous(base + 3),
                }),
                keep: false,
            },
            Command {
                operation: Operation::StorageRead(lit("batch-probe.txt")),
                keep: true,
            },
        ]);
    }
    #[cfg(feature = "batch-host")]
    let replies = match batch::execute(&commands) {
        Ok(replies) => replies,
        Err(e) if input["reportFailure"] == true => {
            return Ok(json!({
                "index": e.index,
                "phase": match e.phase {
                    batch::FailurePhase::Validation => "validation",
                    batch::FailurePhase::Execution => "execution",
                    batch::FailurePhase::ResultLimit => "result-limit",
                },
                "completed": e.completed,
                "replies": reply_json(e.replies),
            }));
        }
        Err(e) => return Err(format!("batch {}: {:?}", e.index, e.cause)),
    };
    #[cfg(not(feature = "batch-host"))]
    let replies = {
        let mut values = Vec::new();
        for command in &commands {
            let value = match &command.operation {
                Operation::ClockAdd(a) => HostValue::Text(
                    clock::add(get(&a.timestamp, &values)?, a.amount, a.unit)
                        .map_err(|e| format!("{e:?}"))?,
                ),
                Operation::ClockFormat(a) => HostValue::Text(
                    clock::format(
                        get(&a.timestamp, &values)?,
                        get(&a.pattern, &values)?,
                        a.locale.as_ref().map(|t| get(t, &values)).transpose()?,
                    )
                    .map_err(|e| format!("{e:?}"))?,
                ),
                Operation::NotesGet(id) => {
                    HostValue::Note(notes::get(get(id, &values)?).map_err(|e| format!("{e:?}"))?)
                }
                Operation::Frontmatter(s) => HostValue::Text(
                    markdown::frontmatter(get(s, &values)?).map_err(|e| format!("{e:?}"))?,
                ),
                Operation::HasPermission(p) => {
                    HostValue::Boolean(runtime::has_permission(get(p, &values)?))
                }
                Operation::StorageWrite(a) => {
                    storage::write(get(&a.path, &values)?, get(&a.contents, &values)?)
                        .map_err(|e| format!("{e:?}"))?;
                    HostValue::None
                }
                Operation::StorageRead(p) => HostValue::OptionalText(
                    storage::read(get(p, &values)?).map_err(|e| format!("{e:?}"))?,
                ),
                _ => return Err("unexpected probe operation".into()),
            };
            values.push(value);
        }
        values
            .into_iter()
            .zip(commands)
            .enumerate()
            .filter_map(|(i, (value, c))| {
                c.keep.then_some(Reply {
                    index: i as u32,
                    value,
                })
            })
            .collect::<Vec<_>>()
    };
    Ok(reply_json(replies))
}

fn reply_json(replies: Vec<crate::mindstream::plugin::batch::Reply>) -> Value {
    Value::Array(replies.into_iter().map(|r|json!({"index":r.index,"value":match r.value {
  HostValue::Text(s)=>json!(s),HostValue::OptionalText(s)=>json!(s),HostValue::Boolean(b)=>json!(b),HostValue::Note(n)=>json!(n.map(|n|json!({"id":n.id,"title":n.title}))),_=>Value::Null
 }})).collect())
}
