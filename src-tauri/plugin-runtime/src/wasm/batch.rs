//! Bounded ordered batching. Dispatches to the same HostContext as scalar APIs.
use super::bindings::{
    mindstream::plugin::{batch::*, types},
    note, time_unit,
};
use crate::{
    dates::DateInput,
    error::{HostError, HostResult},
    host::{HostContext, LogLevel, ToolRunOptions},
};

pub const MAX_COMMANDS: usize = 128;
pub const MAX_INPUT_BYTES: usize = 1024 * 1024;
pub const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;

fn failure(
    index: usize,
    phase: FailurePhase,
    completed: usize,
    replies: Vec<Reply>,
    error: HostError,
) -> HostResult<Failure> {
    let cause = match error {
        HostError::Denied(p) => types::Error::Denied(p.into()),
        HostError::Invalid(m) => types::Error::Invalid(m),
        HostError::Unavailable(m) => types::Error::Unavailable(m),
        HostError::Io(e) => types::Error::Failed(e.to_string()),
        fatal @ (HostError::Budget | HostError::Cancelled) => return Err(fatal),
    };
    Ok(Failure {
        index: index as u32,
        phase,
        completed: completed as u32,
        replies,
        cause,
    })
}

fn replies(commands: &[Command], values: Vec<Value>) -> Vec<Reply> {
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
        .collect()
}

fn inputs(op: &Operation) -> Vec<&TextInput> {
    match op {
        Operation::Log(a) => vec![&a.message],
        Operation::HasPermission(a)
        | Operation::Frontmatter(a)
        | Operation::NotesGet(a)
        | Operation::StorageRead(a)
        | Operation::StorageList(a)
        | Operation::StorageDelete(a)
        | Operation::ToolAvailable(a) => vec![a],
        Operation::ClockFormat(a) => {
            let mut v = vec![&a.timestamp, &a.pattern];
            v.extend(a.locale.iter());
            v
        }
        Operation::ClockAdd(a) => vec![&a.timestamp],
        Operation::StorageWrite(a) => vec![&a.path, &a.contents],
        Operation::ToolRun(a) => {
            let mut v = vec![&a.tool_id];
            v.extend(a.args.iter());
            v.extend(a.stdin.iter());
            v
        }
        _ => vec![],
    }
}
fn produces_text(op: &Operation) -> bool {
    matches!(
        op,
        Operation::Uuid
            | Operation::Now
            | Operation::ClockAdd(_)
            | Operation::ClockFormat(_)
            | Operation::Frontmatter(_)
            | Operation::StorageRead(_)
    )
}
fn validate(commands: &[Command]) -> Result<(), (usize, HostError)> {
    if commands.len() > MAX_COMMANDS {
        return Err((0, HostError::Invalid("batch: at most 128 commands".into())));
    }
    let mut size = 0usize;
    let mut count = 0usize;
    for (index, command) in commands.iter().enumerate() {
        if matches!(&command.operation,Operation::ToolRun(a) if a.args.len()>1024) {
            return Err((
                index,
                HostError::Invalid("batch: at most 1024 text inputs".into()),
            ));
        }
        let args = inputs(&command.operation);
        count = count.saturating_add(args.len());
        if count > 1024 {
            return Err((
                index,
                HostError::Invalid("batch: at most 1024 text inputs".into()),
            ));
        }
        for input in args {
            match input {
                TextInput::Literal(text) => size = size.saturating_add(text.len()),
                TextInput::Previous(i) => {
                    let i = *i as usize;
                    if i >= index || !produces_text(&commands[i].operation) {
                        return Err((index,HostError::Invalid("batch: reference must point to an earlier text-producing operation".into())));
                    }
                }
            }
        }
        if size > MAX_INPUT_BYTES {
            return Err((
                index,
                HostError::Invalid("batch: literal input exceeds 1 MiB".into()),
            ));
        }
    }
    Ok(())
}
fn text<'a>(input: &'a TextInput, values: &'a [Value]) -> HostResult<&'a str> {
    match input {
        TextInput::Literal(text) => Ok(text),
        TextInput::Previous(i) => match &values[*i as usize] {
            Value::Text(text) | Value::OptionalText(Some(text)) => Ok(text),
            _ => Err(HostError::Invalid(
                "batch: reference has no text value".into(),
            )),
        },
    }
}
fn dispatch(host: &HostContext, op: &Operation, values: &[Value]) -> HostResult<Value> {
    let get = |t| text(t, values);
    Ok(match op {
        Operation::Log(a) => {
            host.log(
                match a.level {
                    super::bindings::mindstream::plugin::runtime::LogLevel::Debug => {
                        LogLevel::Debug
                    }
                    super::bindings::mindstream::plugin::runtime::LogLevel::Info => LogLevel::Info,
                    super::bindings::mindstream::plugin::runtime::LogLevel::Warn => LogLevel::Warn,
                    super::bindings::mindstream::plugin::runtime::LogLevel::Error => {
                        LogLevel::Error
                    }
                },
                get(&a.message)?,
            );
            Value::None
        }
        Operation::Uuid => Value::Text(host.uuid()),
        Operation::RandomBytes(n) => Value::Bytes(host.random_bytes(*n)?),
        Operation::HasPermission(p) => Value::Boolean(host.granted(get(p)?)),
        Operation::NowMillis => Value::Number(host.now_millis()),
        Operation::Now => Value::Text(host.now_rfc3339()),
        Operation::ClockFormat(a) => Value::Text(host.date_format(
            &DateInput::Rfc3339(get(&a.timestamp)?.into()),
            get(&a.pattern)?,
            a.locale.as_ref().map(get).transpose()?.unwrap_or("en"),
        )?),
        Operation::ClockAdd(a) => Value::Text(host.date_add(
            &DateInput::Rfc3339(get(&a.timestamp)?.into()),
            a.amount,
            time_unit(a.unit),
        )?),
        Operation::Frontmatter(a) => {
            let fields = serde_json::from_str(get(a)?)
                .map_err(|e| HostError::Invalid(format!("frontmatter: invalid JSON: {e}")))?;
            Value::Text(host.frontmatter(&fields)?)
        }
        Operation::NotesAll => Value::Notes(host.notes_all()?.iter().map(note).collect()),
        Operation::NotesGet(id) => Value::Note(host.notes_get(get(id)?)?.map(note)),
        Operation::StorageRead(path) => Value::OptionalText(host.storage_read(get(path)?)?),
        Operation::StorageList(path) => Value::Entries(
            host.storage_list(get(path)?)?
                .into_iter()
                .map(|e| super::bindings::mindstream::plugin::storage::Entry {
                    name: e.name,
                    is_dir: e.is_dir,
                    size_bytes: e.size_bytes,
                })
                .collect(),
        ),
        Operation::StorageWrite(a) => {
            host.storage_write(get(&a.path)?, get(&a.contents)?)?;
            Value::None
        }
        Operation::StorageDelete(path) => {
            host.storage_delete(get(path)?)?;
            Value::None
        }
        Operation::ToolAvailable(id) => Value::Boolean(host.tool_available(get(id)?)?),
        Operation::ToolRun(a) => {
            let o = host.tool_run(
                get(&a.tool_id)?,
                ToolRunOptions {
                    args: a
                        .args
                        .iter()
                        .map(get)
                        .map(|r| r.map(String::from))
                        .collect::<HostResult<_>>()?,
                    stdin: a.stdin.as_ref().map(get).transpose()?.map(String::from),
                    timeout_ms: a.timeout_ms.map(u64::from),
                    output_base64: a.output_base64,
                },
            )?;
            Value::Tool(
                super::bindings::mindstream::plugin::native_tools::RunOutput {
                    status_code: o.status_code,
                    stdout: o.stdout,
                    stdout_base64: o.stdout_base64,
                    stderr: o.stderr,
                    timed_out: o.timed_out,
                },
            )
        }
    })
}
fn note_size(n: &types::NoteMeta) -> usize {
    64 + n.id.len()
        + n.title.len()
        + n.tags.iter().map(|s| s.len() + 8).sum::<usize>()
        + n.kind.len()
        + n.folder_id.as_ref().map_or(0, String::len)
        + n.folder_path.len()
        + n.created.len()
        + n.modified.len()
}
fn result_size(v: &Value) -> usize {
    32 + match v {
        Value::Text(s) => s.len(),
        Value::OptionalText(s) => s.as_ref().map_or(0, String::len),
        Value::Bytes(b) => b.len(),
        Value::Notes(ns) => ns.iter().map(note_size).sum(),
        Value::Note(n) => n.as_ref().map_or(0, note_size),
        Value::Entries(es) => es.iter().map(|e| 32 + e.name.len()).sum(),
        Value::Tool(o) => {
            32 + o.stdout.len() + o.stdout_base64.as_ref().map_or(0, String::len) + o.stderr.len()
        }
        _ => 0,
    }
}

pub fn execute(
    host: &HostContext,
    commands: Vec<Command>,
) -> HostResult<Result<Vec<Reply>, Failure>> {
    host.check()?;
    if let Err((i, e)) = validate(&commands) {
        return Ok(Err(failure(i, FailurePhase::Validation, 0, vec![], e)?));
    }
    let mut values = Vec::with_capacity(commands.len());
    let mut size = 0usize;
    for (i, command) in commands.iter().enumerate() {
        host.check()?;
        let value = match dispatch(host, &command.operation, &values) {
            Ok(v) => v,
            Err(e) => {
                return Ok(Err(failure(
                    i,
                    FailurePhase::Execution,
                    i,
                    replies(&commands, values),
                    e,
                )?));
            }
        };
        size = size.saturating_add(result_size(&value));
        if size > MAX_RESULT_BYTES {
            return Ok(Err(failure(
                i,
                FailurePhase::ResultLimit,
                i + 1,
                replies(&commands, values),
                HostError::Invalid("batch: result data exceeds 8 MiB".into()),
            )?));
        }
        values.push(value);
        host.check()?;
    }
    Ok(Ok(replies(&commands, values)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        cancel::CancelToken,
        host::{
            CallSetup, PERM_NATIVE_TOOLS, PERM_NOTES_READ, PERM_STORAGE_READ, PERM_STORAGE_WRITE,
        },
        limits,
    };
    fn lit(s: &str) -> TextInput {
        TextInput::Literal(s.into())
    }
    fn cmd(operation: Operation, keep: bool) -> Command {
        Command { operation, keep }
    }
    fn host(permissions: &[&str], root: Option<std::path::PathBuf>) -> HostContext {
        HostContext::new(
            CallSetup {
                permissions: permissions.iter().map(|s| (*s).into()).collect(),
                data_root: root,
                native_tools: std::collections::HashMap::from([("missing".into(), None)]),
                ..Default::default()
            },
            limits::WASM.resolve(None, None),
            limits::NATIVE_ALLOWANCE,
        )
    }
    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("batch-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn empty_and_mixed_capabilities_with_unkept_dependency() {
        let root = Scratch::new();
        let host = host(
            &[
                PERM_NOTES_READ,
                PERM_STORAGE_READ,
                PERM_STORAGE_WRITE,
                PERM_NATIVE_TOOLS,
            ],
            Some(root.0.clone()),
        );
        assert!(execute(&host, vec![]).unwrap().unwrap().is_empty());
        let out = execute(
            &host,
            vec![
                cmd(Operation::Frontmatter(lit("{\"z\":1}")), false),
                cmd(
                    Operation::StorageWrite(WriteRequest {
                        path: lit("value.txt"),
                        contents: TextInput::Previous(0),
                    }),
                    false,
                ),
                cmd(Operation::StorageRead(lit("value.txt")), true),
                cmd(Operation::HasPermission(lit(PERM_NOTES_READ)), true),
                cmd(Operation::NotesAll, true),
                cmd(Operation::NotesGet(lit("none")), true),
                cmd(Operation::ToolAvailable(lit("missing")), true),
                cmd(Operation::StorageList(lit("")), true),
                cmd(Operation::StorageDelete(lit("value.txt")), true),
                cmd(Operation::Uuid, true),
                cmd(Operation::RandomBytes(8), true),
                cmd(Operation::NowMillis, true),
                cmd(Operation::Now, true),
                cmd(
                    Operation::Log(LogRequest {
                        level: super::super::bindings::mindstream::plugin::runtime::LogLevel::Info,
                        message: lit("batch test"),
                    }),
                    false,
                ),
            ],
        )
        .unwrap()
        .unwrap();
        assert_eq!(out.len(), 11);
        assert_eq!(out[0].index, 2);
        assert!(matches!(&out[0].value,Value::OptionalText(Some(s)) if s.contains("z: 1")));
        assert!(matches!(out[1].value, Value::Boolean(true)));
        assert!(matches!(&out[2].value,Value::Notes(n) if n.is_empty()));
        assert!(matches!(&out[3].value, Value::Note(None)));
        assert!(matches!(&out[4].value, Value::Boolean(false)));
        assert!(matches!(&out[7].value,Value::Text(s) if uuid::Uuid::parse_str(s).is_ok()));
        assert!(matches!(&out[8].value,Value::Bytes(b) if b.len()==8));
        assert!(!root.0.join("value.txt").exists());
    }
    #[test]
    fn backward_clock_chain_matches_scalar_host() {
        let host = host(&[], None);
        let now = "2026-01-31T12:00:00Z";
        let expected = host
            .date_add(
                &DateInput::Rfc3339(now.into()),
                1,
                crate::dates::TimeUnit::Month,
            )
            .unwrap();
        let expected = host
            .date_format(&DateInput::Rfc3339(expected), "YYYY-MM-DD", "de")
            .unwrap();
        let out = execute(
            &host,
            vec![
                cmd(
                    Operation::ClockAdd(AddRequest {
                        timestamp: lit(now),
                        amount: 1,
                        unit: super::super::bindings::mindstream::plugin::clock::TimeUnit::Month,
                    }),
                    false,
                ),
                cmd(
                    Operation::ClockFormat(FormatRequest {
                        timestamp: TextInput::Previous(0),
                        pattern: lit("YYYY-MM-DD"),
                        locale: Some(lit("de")),
                    }),
                    true,
                ),
            ],
        )
        .unwrap()
        .unwrap();
        assert!(matches!(&out[0].value,Value::Text(s) if *s==expected));
    }
    #[test]
    fn validates_whole_plan_before_any_side_effect() {
        let root = Scratch::new();
        let host = host(&[PERM_STORAGE_WRITE], Some(root.0.clone()));
        let first = || {
            cmd(
                Operation::StorageWrite(WriteRequest {
                    path: lit("first.txt"),
                    contents: lit("saved"),
                }),
                false,
            )
        };
        for reference in [0, 1, 2, u32::MAX] {
            let err = execute(
                &host,
                vec![
                    first(),
                    cmd(Operation::Frontmatter(TextInput::Previous(reference)), true),
                ],
            )
            .unwrap()
            .unwrap_err();
            assert_eq!(err.index, 1);
            assert!(matches!(err.phase, FailurePhase::Validation));
            assert_eq!(err.completed, 0);
            assert!(err.replies.is_empty());
            assert!(matches!(err.cause, types::Error::Invalid(_)));
            assert!(!root.0.join("first.txt").exists());
        }
        let err = execute(
            &host,
            vec![
                first(),
                cmd(
                    Operation::Frontmatter(lit(&"a".repeat(MAX_INPUT_BYTES))),
                    true,
                ),
            ],
        )
        .unwrap()
        .unwrap_err();
        assert!(matches!(err.cause, types::Error::Invalid(_)));
        assert!(!root.0.join("first.txt").exists());
    }
    #[test]
    fn permission_failure_stops_later_operations_without_rollback() {
        let root = Scratch::new();
        let host = host(&[PERM_STORAGE_WRITE], Some(root.0.clone()));
        let write = |path| {
            cmd(
                Operation::StorageWrite(WriteRequest {
                    path: lit(path),
                    contents: lit("saved"),
                }),
                false,
            )
        };
        let err = execute(
            &host,
            vec![
                write("first.txt"),
                cmd(Operation::Frontmatter(lit("{\"title\":\"Saved\"}")), true),
                cmd(Operation::NotesAll, true),
                write("later.txt"),
            ],
        )
        .unwrap()
        .unwrap_err();
        assert_eq!(err.index, 2);
        assert!(matches!(err.phase, FailurePhase::Execution));
        assert_eq!(err.completed, 2);
        assert_eq!(err.replies.len(), 1);
        assert_eq!(err.replies[0].index, 1);
        assert!(matches!(&err.replies[0].value, Value::Text(s) if s.contains("Saved")));
        assert!(matches!(&err.cause,types::Error::Denied(p) if p==PERM_NOTES_READ));
        assert!(root.0.join("first.txt").exists());
        assert!(!root.0.join("later.txt").exists());
    }
    #[test]
    fn referenced_storage_paths_keep_containment_and_missing_text_is_an_error() {
        let root = Scratch::new();
        let host = host(
            &[PERM_STORAGE_READ, PERM_STORAGE_WRITE],
            Some(root.0.clone()),
        );
        host.storage_write("path.txt", "../escape.txt").unwrap();
        let err = execute(
            &host,
            vec![
                cmd(Operation::StorageRead(lit("path.txt")), false),
                cmd(
                    Operation::StorageWrite(WriteRequest {
                        path: TextInput::Previous(0),
                        contents: lit("bad"),
                    }),
                    true,
                ),
            ],
        )
        .unwrap()
        .unwrap_err();
        assert_eq!(err.index, 1);
        assert!(matches!(err.cause, types::Error::Invalid(_)));
        let err = execute(
            &host,
            vec![
                cmd(Operation::StorageRead(lit("missing")), false),
                cmd(Operation::Frontmatter(TextInput::Previous(0)), true),
            ],
        )
        .unwrap()
        .unwrap_err();
        assert_eq!(err.index, 1);
        assert!(matches!(err.cause, types::Error::Invalid(_)));
    }
    #[test]
    fn native_run_keeps_permission_and_declared_tool_policy() {
        let op = || {
            cmd(
                Operation::ToolRun(ToolRequest {
                    tool_id: lit("missing"),
                    args: vec![],
                    stdin: None,
                    timeout_ms: None,
                    output_base64: false,
                }),
                true,
            )
        };
        let err = execute(&host(&[], None), vec![op()]).unwrap().unwrap_err();
        assert!(matches!(err.cause, types::Error::Denied(_)));
        let err = execute(&host(&[PERM_NATIVE_TOOLS], None), vec![op()])
            .unwrap()
            .unwrap_err();
        assert!(matches!(err.cause, types::Error::Unavailable(_)));
    }
    #[test]
    fn command_input_and_cumulative_output_limits_apply_to_unkept_values() {
        let host = host(&[], None);
        let too_many_args = cmd(
            Operation::ToolRun(ToolRequest {
                tool_id: lit("missing"),
                args: (0..1025).map(|_| lit("")).collect(),
                stdin: None,
                timeout_ms: None,
                output_base64: false,
            }),
            true,
        );
        let err = execute(&host, vec![too_many_args]).unwrap().unwrap_err();
        assert!(matches!(err.cause, types::Error::Invalid(_)));
        let commands = (0..129).map(|_| cmd(Operation::NowMillis, false)).collect();
        let err = execute(&host, commands).unwrap().unwrap_err();
        assert_eq!(err.index, 0);
        assert!(matches!(err.phase, FailurePhase::Validation));
        assert_eq!(err.completed, 0);
        assert!(err.replies.is_empty());
        let commands = (0..128)
            .map(|i| cmd(Operation::RandomBytes(65536), i == 0 || i == 127))
            .collect();
        let err = execute(&host, commands).unwrap().unwrap_err();
        assert!(matches!(err.cause, types::Error::Invalid(_)));
        assert_eq!(err.index, 127);
        assert!(matches!(err.phase, FailurePhase::ResultLimit));
        assert_eq!(err.completed, 128);
        assert_eq!(err.replies.len(), 1);
        assert_eq!(err.replies[0].index, 0);
        assert!(matches!(&err.replies[0].value, Value::Bytes(b) if b.len() == 65536));
        let err = execute(&host, vec![cmd(Operation::RandomBytes(65537), true)])
            .unwrap()
            .unwrap_err();
        assert!(matches!(err.cause, types::Error::Invalid(_)));
        assert!(matches!(err.phase, FailurePhase::Execution));
        assert_eq!(err.completed, 0);
        assert!(err.replies.is_empty());
    }
    #[test]
    fn cancellation_and_deadline_are_fatal_not_batch_error_values() {
        let cancel = CancelToken::default();
        cancel.cancel();
        let host = HostContext::new(
            CallSetup {
                cancel,
                ..Default::default()
            },
            limits::WASM.resolve(None, None),
            limits::NATIVE_ALLOWANCE,
        );
        assert!(matches!(execute(&host, vec![]), Err(HostError::Cancelled)));
        let mut limits = limits::WASM.resolve(None, None);
        limits.timeout = std::time::Duration::ZERO;
        let host = HostContext::new(CallSetup::default(), limits, limits::NATIVE_ALLOWANCE);
        assert!(matches!(
            execute(&host, vec![cmd(Operation::NowMillis, true)]),
            Err(HostError::Budget)
        ));
    }
}
