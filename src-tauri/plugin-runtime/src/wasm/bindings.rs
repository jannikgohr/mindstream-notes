//! The `mindstream:plugin` world as Rust, and the host side of every import.
//!
//! Each import is a direct call into [`HostContext`]. The one decision made
//! here is how a [`HostError`] reaches the guest: as a WIT `error` value it
//! can handle, or, for running out of time and cancellation, as a trap that
//! ends the call (see `convert_error`).

use crate::dates::{DateInput, TimeUnit};
use crate::error::HostError;
use crate::host::{HostContext, LogLevel, NoteMeta, ToolRunOptions};

use super::limiter::CallLimiter;

wasmtime::component::bindgen!({
    path: "../../plugin-sdk/wit",
    world: "mindstream:plugin/plugin",
    imports: { default: trappable },
    trappable_error_type: {
        "mindstream:plugin/types.error" => HostError,
    },
});

use mindstream::plugin::{batch, clock, markdown, native_tools, notes, runtime, storage, types};

/// What a store holds for one call.
pub struct CallState {
    pub host: HostContext,
    pub limiter: CallLimiter,
}

impl types::Host for CallState {
    fn convert_error(&mut self, err: HostError) -> wasmtime::Result<types::Error> {
        Ok(match err {
            HostError::Denied(permission) => types::Error::Denied(permission.to_string()),
            HostError::Invalid(message) => types::Error::Invalid(message),
            HostError::Unavailable(message) => types::Error::Unavailable(message),
            HostError::Io(io) => types::Error::Failed(io.to_string()),
            // Not something a guest gets to catch.
            fatal @ (HostError::Budget | HostError::Cancelled) => {
                return Err(wasmtime::Error::new(fatal))
            }
        })
    }
}

/// A host refusal that has no WIT error slot (a function without `result`)
/// becomes a trap carrying the error.
fn trap(err: HostError) -> wasmtime::Error {
    wasmtime::Error::new(err)
}

impl runtime::Host for CallState {
    fn log(&mut self, level: runtime::LogLevel, message: String) -> wasmtime::Result<()> {
        let level = match level {
            runtime::LogLevel::Debug => LogLevel::Debug,
            runtime::LogLevel::Info => LogLevel::Info,
            runtime::LogLevel::Warn => LogLevel::Warn,
            runtime::LogLevel::Error => LogLevel::Error,
        };
        self.host.log(level, &message);
        Ok(())
    }

    fn uuid(&mut self) -> wasmtime::Result<String> {
        Ok(self.host.uuid())
    }

    fn random_bytes(&mut self, len: u32) -> wasmtime::Result<Vec<u8>> {
        self.host.random_bytes(len).map_err(trap)
    }

    fn has_permission(&mut self, permission: String) -> wasmtime::Result<bool> {
        Ok(self.host.granted(&permission))
    }
}

pub(super) fn time_unit(unit: clock::TimeUnit) -> TimeUnit {
    match unit {
        clock::TimeUnit::Second => TimeUnit::Second,
        clock::TimeUnit::Minute => TimeUnit::Minute,
        clock::TimeUnit::Hour => TimeUnit::Hour,
        clock::TimeUnit::Day => TimeUnit::Day,
        clock::TimeUnit::Week => TimeUnit::Week,
        clock::TimeUnit::Month => TimeUnit::Month,
        clock::TimeUnit::Year => TimeUnit::Year,
    }
}

impl clock::Host for CallState {
    fn now_millis(&mut self) -> wasmtime::Result<u64> {
        Ok(self.host.now_millis())
    }

    fn now(&mut self) -> wasmtime::Result<String> {
        Ok(self.host.now_rfc3339())
    }

    fn format(
        &mut self,
        timestamp: String,
        pattern: String,
        locale: Option<String>,
    ) -> Result<String, HostError> {
        self.host.date_format(
            &DateInput::Rfc3339(timestamp),
            &pattern,
            locale.as_deref().unwrap_or("en"),
        )
    }

    fn add(
        &mut self,
        timestamp: String,
        amount: i64,
        unit: clock::TimeUnit,
    ) -> Result<String, HostError> {
        self.host
            .date_add(&DateInput::Rfc3339(timestamp), amount, time_unit(unit))
    }
}

impl markdown::Host for CallState {
    fn frontmatter(&mut self, fields_json: String) -> Result<String, HostError> {
        let fields: serde_json::Value = serde_json::from_str(&fields_json)
            .map_err(|e| HostError::Invalid(format!("frontmatter: invalid JSON: {e}")))?;
        self.host.frontmatter(&fields)
    }
}

pub(super) fn note(meta: &NoteMeta) -> types::NoteMeta {
    types::NoteMeta {
        id: meta.id.clone(),
        title: meta.title.clone(),
        tags: meta.tags.clone(),
        kind: meta.kind.clone(),
        folder_id: meta.folder_id.clone(),
        folder_path: meta.folder_path.clone(),
        created: meta.created.clone(),
        modified: meta.modified.clone(),
    }
}

impl notes::Host for CallState {
    fn all(&mut self) -> Result<Vec<types::NoteMeta>, HostError> {
        Ok(self.host.notes_all()?.iter().map(note).collect())
    }

    fn get(&mut self, id: String) -> Result<Option<types::NoteMeta>, HostError> {
        Ok(self.host.notes_get(&id)?.map(note))
    }
}

impl storage::Host for CallState {
    fn read(&mut self, path: String) -> Result<Option<String>, HostError> {
        self.host.storage_read(&path)
    }

    fn list(&mut self, path: String) -> Result<Vec<storage::Entry>, HostError> {
        Ok(self
            .host
            .storage_list(&path)?
            .into_iter()
            .map(|e| storage::Entry {
                name: e.name,
                is_dir: e.is_dir,
                size_bytes: e.size_bytes,
            })
            .collect())
    }

    fn write(&mut self, path: String, contents: String) -> Result<(), HostError> {
        self.host.storage_write(&path, &contents)
    }

    fn delete(&mut self, path: String) -> Result<(), HostError> {
        self.host.storage_delete(&path)
    }
}

impl native_tools::Host for CallState {
    fn available(&mut self, tool_id: String) -> Result<bool, HostError> {
        self.host.tool_available(&tool_id)
    }

    fn run(
        &mut self,
        tool_id: String,
        options: native_tools::RunOptions,
    ) -> Result<native_tools::RunOutput, HostError> {
        let output = self.host.tool_run(
            &tool_id,
            ToolRunOptions {
                args: options.args,
                stdin: options.stdin,
                timeout_ms: options.timeout_ms.map(u64::from),
                output_base64: options.output_base64,
            },
        )?;
        Ok(native_tools::RunOutput {
            status_code: output.status_code,
            stdout: output.stdout,
            stdout_base64: output.stdout_base64,
            stderr: output.stderr,
            timed_out: output.timed_out,
        })
    }
}

impl batch::Host for CallState {
    fn execute(
        &mut self,
        commands: Vec<batch::Command>,
    ) -> wasmtime::Result<Result<Vec<batch::Reply>, batch::Failure>> {
        super::batch::execute(&self.host, commands).map_err(trap)
    }
}
