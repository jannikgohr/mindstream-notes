//! The host services a plugin call can reach, shared by every runtime.
//!
//! A runtime adapter (Luau's `ms.*` table, the Wasm component's imports) is a
//! thin translation onto the methods of [`HostContext`]. Permission checks,
//! path containment, size limits and the time budget all live here, once, so
//! a second runtime cannot enforce them differently from the first.
//!
//! Note writes are deliberately absent. A plugin returns data and declarative
//! effects, and the app performs every write itself.

use std::cell::Cell;
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Serialize;

use crate::cancel::CancelToken;
use crate::dates::{self, DateInput, TimeUnit};
use crate::error::{HostError, HostResult};
use crate::limits::{ExecutionBudget, Limits};
use crate::{markdown, paths, process};

pub const PERM_NOTES_READ: &str = "notes.read";
pub const PERM_STORAGE_READ: &str = "pluginStorage.read";
pub const PERM_STORAGE_WRITE: &str = "pluginStorage.write";
pub const PERM_NATIVE_TOOLS: &str = "nativeTools.runDeclared";

/// Largest single file storage reads or writes. Plugin storage is for a
/// plugin's own state, not a corpus, and an unbounded read would pull an
/// arbitrary amount into guest memory in one call.
pub const MAX_STORAGE_FILE_BYTES: usize = 4 * 1024 * 1024;
/// Longest log line kept. The rest is cut off.
pub const MAX_LOG_LINE_BYTES: usize = 8 * 1024;
/// Log lines one call may write before the rest are dropped.
pub const MAX_LOG_LINES: u32 = 200;
pub const MAX_RANDOM_BYTES: u32 = 64 * 1024;

/// Read-only metadata for one note. Never the body: the snapshot is cheap to
/// build and copy. Field names are what Luau scripts see.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NoteMeta {
    pub id: String,
    pub title: String,
    pub tags: Vec<String>,
    /// Editor kind (`markdown`, `kanban`, ...).
    pub kind: String,
    pub folder_id: Option<String>,
    /// Folder names from the root down, joined with ` / `.
    pub folder_path: String,
    pub created: String,
    pub modified: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageEntry {
    pub name: String,
    pub is_dir: bool,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Default)]
pub struct ToolRunOptions {
    pub args: Vec<String>,
    pub stdin: Option<String>,
    pub timeout_ms: Option<u64>,
    pub output_base64: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolRunOutput {
    pub status_code: Option<i32>,
    /// Empty when `output_base64` was set.
    pub stdout: String,
    pub stdout_base64: Option<String>,
    pub stderr: String,
    pub timed_out: bool,
}

/// Everything the host needs to set up one call.
#[derive(Debug, Clone, Default)]
pub struct CallSetup {
    pub plugin_id: String,
    /// What the user granted, from the database record, never from the
    /// manifest on disk.
    pub permissions: Vec<String>,
    /// Snapshot behind `notes.*`. Empty unless `notes.read` was granted.
    pub notes: Vec<NoteMeta>,
    /// Every declared native tool by manifest id, resolved to its binary.
    /// `None` is declared but not found, which is always the case on mobile.
    pub native_tools: HashMap<String, Option<PathBuf>>,
    /// The plugin's own data directory: the root of storage and the working
    /// directory of native tools. `None` turns both off.
    pub data_root: Option<PathBuf>,
    pub cancel: CancelToken,
}

/// The host side of one plugin call.
#[derive(Debug)]
pub struct HostContext {
    plugin_id: String,
    permissions: BTreeSet<String>,
    notes: Arc<Vec<NoteMeta>>,
    native_tools: Arc<HashMap<String, Option<PathBuf>>>,
    data_root: Option<PathBuf>,
    budget: ExecutionBudget,
    cancel: CancelToken,
    log_lines: Cell<u32>,
}

impl HostContext {
    /// Start the call's clock and wrap up what it may reach.
    pub fn new(setup: CallSetup, limits: Limits, native_allowance: Duration) -> Self {
        Self {
            plugin_id: setup.plugin_id,
            permissions: setup.permissions.into_iter().collect(),
            notes: Arc::new(setup.notes),
            native_tools: Arc::new(setup.native_tools),
            data_root: setup.data_root,
            budget: ExecutionBudget::start(limits.timeout, native_allowance),
            cancel: setup.cancel,
            log_lines: Cell::new(0),
        }
    }

    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    pub fn granted(&self, permission: &str) -> bool {
        self.permissions.contains(permission)
    }

    fn require(&self, permission: &'static str) -> HostResult<()> {
        if self.granted(permission) {
            Ok(())
        } else {
            Err(HostError::Denied(permission))
        }
    }

    pub fn cancel_token(&self) -> &CancelToken {
        &self.cancel
    }

    /// [`HostError::Cancelled`] or [`HostError::Budget`] once the call has to
    /// stop. Runtimes call this from their interrupt hooks.
    pub fn check(&self) -> HostResult<()> {
        if self.cancel.is_cancelled() {
            return Err(HostError::Cancelled);
        }
        self.budget.check()
    }

    // ---- Always available -------------------------------------------------

    /// One line in the app log, tagged with the plugin id.
    pub fn log(&self, level: LogLevel, message: &str) {
        let count = self.log_lines.get();
        if count > MAX_LOG_LINES {
            return;
        }
        self.log_lines.set(count + 1);
        if count == MAX_LOG_LINES {
            log::warn!(
                "[plugin {}] more than {MAX_LOG_LINES} log lines in one call; dropping the rest",
                self.plugin_id
            );
            return;
        }
        let mut line = message;
        if line.len() > MAX_LOG_LINE_BYTES {
            let mut end = MAX_LOG_LINE_BYTES;
            while !line.is_char_boundary(end) {
                end -= 1;
            }
            line = &line[..end];
        }
        let level = match level {
            LogLevel::Debug => log::Level::Debug,
            LogLevel::Info => log::Level::Info,
            LogLevel::Warn => log::Level::Warn,
            LogLevel::Error => log::Level::Error,
        };
        log::log!(level, "[plugin {}] {line}", self.plugin_id);
    }

    pub fn uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }

    pub fn random_bytes(&self, len: u32) -> HostResult<Vec<u8>> {
        if len > MAX_RANDOM_BYTES {
            return Err(HostError::Invalid(format!(
                "random-bytes: at most {MAX_RANDOM_BYTES} bytes per call"
            )));
        }
        let mut buf = vec![0; len as usize];
        getrandom::fill(&mut buf)
            .map_err(|e| HostError::Io(std::io::Error::other(e.to_string())))?;
        Ok(buf)
    }

    pub fn now_millis(&self) -> u64 {
        u64::try_from(chrono::Utc::now().timestamp_millis()).unwrap_or(0)
    }

    pub fn now_rfc3339(&self) -> String {
        dates::now().to_rfc3339()
    }

    /// The current local time, shifted by whole days, then formatted.
    pub fn date_now(&self, pattern: &str, offset_days: i64, locale: &str) -> HostResult<String> {
        let shifted = dates::add(dates::now(), offset_days, TimeUnit::Day)
            .ok_or_else(|| HostError::Invalid("date offset is out of range".into()))?;
        Ok(dates::format(&shifted, pattern, locale))
    }

    pub fn date_format(
        &self,
        input: &DateInput,
        pattern: &str,
        locale: &str,
    ) -> HostResult<String> {
        let dt = input.to_local().ok_or_else(|| {
            HostError::Invalid("date input must be an RFC3339 string or epoch seconds".into())
        })?;
        Ok(dates::format(&dt, pattern, locale))
    }

    pub fn date_add(&self, input: &DateInput, amount: i64, unit: TimeUnit) -> HostResult<String> {
        let dt = input.to_local().ok_or_else(|| {
            HostError::Invalid("date input must be an RFC3339 string or epoch seconds".into())
        })?;
        dates::add(dt, amount, unit)
            .map(|shifted| shifted.to_rfc3339())
            .ok_or_else(|| HostError::Invalid("date shift is out of range".into()))
    }

    pub fn frontmatter(&self, fields: &serde_json::Value) -> HostResult<String> {
        markdown::frontmatter(fields)
    }

    // ---- notes.read --------------------------------------------------------

    pub fn notes_all(&self) -> HostResult<&[NoteMeta]> {
        self.require(PERM_NOTES_READ)?;
        Ok(&self.notes)
    }

    pub fn notes_get(&self, id: &str) -> HostResult<Option<&NoteMeta>> {
        self.require(PERM_NOTES_READ)?;
        Ok(self.notes.iter().find(|n| n.id == id))
    }

    // ---- pluginStorage.read / .write --------------------------------------

    fn storage_root(&self) -> HostResult<&PathBuf> {
        self.data_root
            .as_ref()
            .ok_or_else(|| HostError::Unavailable("this plugin has no data directory".into()))
    }

    /// A stored file as text, or `None` when it does not exist. "Have I stored
    /// this yet?" is the common first call and should not need error handling.
    pub fn storage_read(&self, rel: &str) -> HostResult<Option<String>> {
        self.require(PERM_STORAGE_READ)?;
        let root = self.storage_root()?;
        let path = paths::join_rel(root, rel, false)?;
        if !path.exists() {
            return Ok(None);
        }
        // Containment first, then size, then read. Canonicalizing is what
        // stops a symlink that points out of the data root before its target
        // is opened.
        paths::ensure_inside_root(root, &path)?;
        if !path.is_file() {
            return Ok(None);
        }
        let len = std::fs::metadata(&path)?.len();
        if len > MAX_STORAGE_FILE_BYTES as u64 {
            return Err(HostError::Invalid(format!(
                "storage.read: '{rel}' is larger than {MAX_STORAGE_FILE_BYTES} bytes"
            )));
        }
        let bytes = std::fs::read(&path)?;
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }

    /// The entries of a directory, sorted by name. Missing lists as empty.
    pub fn storage_list(&self, rel: &str) -> HostResult<Vec<StorageEntry>> {
        self.require(PERM_STORAGE_READ)?;
        let root = self.storage_root()?;
        let dir = paths::join_rel(root, rel, true)?;
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Ok(Vec::new());
        };
        paths::ensure_inside_root(root, &dir)?;
        let mut out: Vec<StorageEntry> = entries
            .flatten()
            .filter_map(|entry| {
                let meta = entry.metadata().ok()?;
                Some(StorageEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    is_dir: meta.is_dir(),
                    size_bytes: meta.len(),
                })
            })
            .collect();
        // A plugin that renders the list should not see it reshuffle between
        // calls because the filesystem felt like it.
        out.sort_by(|a, b| {
            (&a.name, a.is_dir, a.size_bytes).cmp(&(&b.name, b.is_dir, b.size_bytes))
        });
        Ok(out)
    }

    pub fn storage_write(&self, rel: &str, contents: &str) -> HostResult<()> {
        self.require(PERM_STORAGE_WRITE)?;
        if contents.len() > MAX_STORAGE_FILE_BYTES {
            return Err(HostError::Invalid(format!(
                "storage.write: '{rel}' exceeds {MAX_STORAGE_FILE_BYTES} bytes"
            )));
        }
        let root = self.storage_root()?;
        let path = paths::join_rel(root, rel, false)?;
        if let Some(parent) = path.parent() {
            paths::create_dir_inside(root, parent)?;
        }
        // A symlink at the target itself would be followed by the write.
        paths::ensure_write_target_safe(root, &path)?;
        std::fs::write(&path, contents)?;
        Ok(())
    }

    /// Remove a file or a tree. Removing what is not there succeeds.
    pub fn storage_delete(&self, rel: &str) -> HostResult<()> {
        self.require(PERM_STORAGE_WRITE)?;
        let root = self.storage_root()?;
        let path = paths::join_rel(root, rel, false)?;
        if std::fs::symlink_metadata(&path).is_err() {
            return Ok(());
        }
        if std::fs::symlink_metadata(&path)?.file_type().is_symlink() {
            // The link itself is inside the root; remove it, never its target.
            std::fs::remove_file(&path)?;
            return Ok(());
        }
        paths::ensure_inside_root(root, &path)?;
        if path.is_dir() {
            std::fs::remove_dir_all(&path)?;
        } else {
            std::fs::remove_file(&path)?;
        }
        Ok(())
    }

    // ---- nativeTools.runDeclared ------------------------------------------

    pub fn tool_available(&self, tool_id: &str) -> HostResult<bool> {
        self.require(PERM_NATIVE_TOOLS)?;
        Ok(self
            .native_tools
            .get(tool_id)
            .is_some_and(|path| path.is_some()))
    }

    /// Run a declared tool and wait for it. Its wall time is credited back to
    /// the script budget, within the call's fixed ceiling.
    pub fn tool_run(&self, tool_id: &str, options: ToolRunOptions) -> HostResult<ToolRunOutput> {
        self.require(PERM_NATIVE_TOOLS)?;
        let binary = match self.native_tools.get(tool_id) {
            None => {
                return Err(HostError::Invalid(format!(
                    "tool '{tool_id}' is not declared in the manifest"
                )))
            }
            Some(None) => {
                return Err(HostError::Unavailable(format!(
                    "tool '{tool_id}' is not available"
                )))
            }
            Some(Some(path)) => path.clone(),
        };
        let cwd = self
            .data_root
            .clone()
            .ok_or_else(|| HostError::Unavailable("no working directory available".into()))?;
        self.check()?;
        let timeout_ms = self.budget.native_timeout_ms(options.timeout_ms)?;
        let started = Instant::now();
        let output = process::run(
            binary,
            cwd,
            options.args,
            options.stdin,
            Some(timeout_ms),
            Some(&self.cancel),
        );
        self.budget.credit(started.elapsed());
        self.check()?;
        let output = output?;
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        let (stdout, stdout_base64) = if options.output_base64 {
            // Binary output is not valid UTF-8, so it travels as base64.
            (
                String::new(),
                Some(base64::engine::general_purpose::STANDARD.encode(&output.stdout)),
            )
        } else {
            (String::from_utf8_lossy(&output.stdout).into_owned(), None)
        };
        Ok(ToolRunOutput {
            status_code: output.status_code,
            stdout,
            stdout_base64,
            stderr,
            timed_out: output.timed_out,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits;

    fn ctx(permissions: &[&str], data_root: Option<PathBuf>) -> HostContext {
        HostContext::new(
            CallSetup {
                plugin_id: "com.test.plugin".into(),
                permissions: permissions.iter().map(|p| p.to_string()).collect(),
                data_root,
                ..CallSetup::default()
            },
            limits::WASM.resolve(None, None),
            limits::NATIVE_ALLOWANCE,
        )
    }

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ms-host-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn note(id: &str, title: &str) -> NoteMeta {
        NoteMeta {
            id: id.into(),
            title: title.into(),
            tags: vec![],
            kind: "markdown".into(),
            folder_id: None,
            folder_path: String::new(),
            created: "2026-07-26T00:00:00Z".into(),
            modified: "2026-07-26T00:00:00Z".into(),
        }
    }

    #[test]
    fn every_capability_is_denied_without_its_permission() {
        let root = scratch();
        let host = ctx(&[], Some(root.clone()));
        let denied = |r: HostResult<()>, p: &str| match r {
            Err(HostError::Denied(name)) => assert_eq!(name, p),
            other => panic!("expected denial of {p}, got {other:?}"),
        };
        denied(host.notes_all().map(drop), PERM_NOTES_READ);
        denied(host.notes_get("a").map(drop), PERM_NOTES_READ);
        denied(host.storage_read("a").map(drop), PERM_STORAGE_READ);
        denied(host.storage_list("").map(drop), PERM_STORAGE_READ);
        denied(host.storage_write("a", "b"), PERM_STORAGE_WRITE);
        denied(host.storage_delete("a"), PERM_STORAGE_WRITE);
        denied(host.tool_available("t").map(drop), PERM_NATIVE_TOOLS);
        denied(
            host.tool_run("t", ToolRunOptions::default()).map(drop),
            PERM_NATIVE_TOOLS,
        );
        // Read alone does not unlock write, or the other way round.
        let reader = ctx(&[PERM_STORAGE_READ], Some(root.clone()));
        denied(reader.storage_write("a", "b"), PERM_STORAGE_WRITE);
        let writer = ctx(&[PERM_STORAGE_WRITE], Some(root.clone()));
        denied(writer.storage_read("a").map(drop), PERM_STORAGE_READ);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn notes_come_from_the_snapshot() {
        let host = HostContext::new(
            CallSetup {
                permissions: vec![PERM_NOTES_READ.into()],
                notes: vec![note("a", "Alpha"), note("b", "Beta")],
                ..CallSetup::default()
            },
            limits::WASM.resolve(None, None),
            limits::NATIVE_ALLOWANCE,
        );
        assert_eq!(host.notes_all().unwrap().len(), 2);
        assert_eq!(host.notes_get("b").unwrap().unwrap().title, "Beta");
        assert!(host.notes_get("zzz").unwrap().is_none());
    }

    #[test]
    fn storage_round_trips_lists_and_deletes() {
        let root = scratch();
        let host = ctx(&[PERM_STORAGE_READ, PERM_STORAGE_WRITE], Some(root.clone()));
        assert_eq!(host.storage_read("state.json").unwrap(), None);
        host.storage_write("b.txt", "second").unwrap();
        host.storage_write("a.txt", "first").unwrap();
        host.storage_write("dir/nested.txt", "deep").unwrap();
        assert_eq!(
            host.storage_read("a.txt").unwrap().as_deref(),
            Some("first")
        );
        assert_eq!(
            host.storage_read("dir").unwrap(),
            None,
            "a directory is not a file"
        );

        let names: Vec<_> = host
            .storage_list("")
            .unwrap()
            .into_iter()
            .map(|e| (e.name, e.is_dir))
            .collect();
        assert_eq!(
            names,
            [
                ("a.txt".to_string(), false),
                ("b.txt".to_string(), false),
                ("dir".to_string(), true)
            ]
        );
        assert_eq!(host.storage_list("dir").unwrap()[0].size_bytes, 4);
        assert!(host.storage_list("missing").unwrap().is_empty());

        host.storage_delete("a.txt").unwrap();
        host.storage_delete("dir").unwrap();
        host.storage_delete("never-was").unwrap();
        assert_eq!(host.storage_read("a.txt").unwrap(), None);
        assert!(!root.join("dir").exists());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn storage_refuses_escapes_and_oversized_files() {
        let root = scratch();
        let host = ctx(&[PERM_STORAGE_READ, PERM_STORAGE_WRITE], Some(root.clone()));
        for path in ["../escape.txt", "/etc/passwd", "a/../../b.txt"] {
            let err = host.storage_write(path, "x").unwrap_err();
            assert!(
                err.to_string().contains("unsafe plugin storage path"),
                "{path}: {err}"
            );
        }
        assert!(!root.parent().unwrap().join("escape.txt").exists());

        let big = "x".repeat(MAX_STORAGE_FILE_BYTES + 1);
        assert!(host
            .storage_write("big.txt", &big)
            .unwrap_err()
            .to_string()
            .contains("exceeds"));
        std::fs::write(root.join("big.txt"), &big).unwrap();
        assert!(host
            .storage_read("big.txt")
            .unwrap_err()
            .to_string()
            .contains("is larger than"));
        std::fs::remove_dir_all(root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn storage_never_follows_a_symlink_out() {
        let root = scratch();
        let outside = scratch();
        let victim = outside.join("victim.txt");
        std::fs::write(&victim, "original").unwrap();
        std::os::unix::fs::symlink(&victim, root.join("escape.txt")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("out")).unwrap();
        let host = ctx(&[PERM_STORAGE_READ, PERM_STORAGE_WRITE], Some(root.clone()));

        assert!(host
            .storage_write("escape.txt", "pwned")
            .unwrap_err()
            .to_string()
            .contains("symlink"));
        assert!(host.storage_read("escape.txt").is_err());
        assert!(host.storage_write("out/new.txt", "x").is_err());
        assert!(host.storage_list("out").is_err());
        // Deleting the link removes the link, not what it points at.
        host.storage_delete("out").unwrap();
        host.storage_delete("escape.txt").unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "original");
        assert!(outside.exists());
        std::fs::remove_dir_all(root).ok();
        std::fs::remove_dir_all(outside).ok();
    }

    #[test]
    fn storage_without_a_data_dir_fails_loudly() {
        let host = ctx(&[PERM_STORAGE_READ, PERM_STORAGE_WRITE], None);
        let err = host.storage_write("x", "y").unwrap_err();
        assert!(matches!(err, HostError::Unavailable(_)));
        assert!(err.to_string().contains("no data directory"));
        assert!(host.storage_read("x").is_err());
        assert!(host.storage_list("").is_err());
        assert!(host.storage_delete("x").is_err());
    }

    #[test]
    fn helpers_need_no_permission() {
        let host = ctx(&[], None);
        assert_eq!(host.uuid().len(), 36);
        assert_eq!(host.random_bytes(16).unwrap().len(), 16);
        assert!(host.random_bytes(MAX_RANDOM_BYTES + 1).is_err());
        assert!(host.now_millis() > 1_700_000_000_000);
        assert!(host.now_rfc3339().contains('T'));
        assert_eq!(host.date_now("YYYY", 0, "en").unwrap().len(), 4);
        assert!(host.date_now("YYYY", i64::MAX, "en").is_err());
        let plus = host
            .date_add(
                &DateInput::Rfc3339("2026-07-25T00:00:00Z".into()),
                1,
                TimeUnit::Month,
            )
            .unwrap();
        assert_eq!(
            host.date_format(&DateInput::Rfc3339(plus), "YYYY-MM", "en")
                .unwrap(),
            "2026-08"
        );
        assert!(host
            .date_format(&DateInput::Rfc3339("nope".into()), "YYYY", "en")
            .is_err());
        assert!(host
            .date_add(&DateInput::Rfc3339("nope".into()), 1, TimeUnit::Day)
            .is_err());
        assert!(host
            .date_add(&DateInput::EpochSeconds(0), i64::MAX, TimeUnit::Year)
            .is_err());
        assert!(host
            .frontmatter(&serde_json::json!({ "a": 1 }))
            .unwrap()
            .contains("a: 1"));
    }

    #[test]
    fn logging_is_capped_per_call() {
        let host = ctx(&[], None);
        let long = "é".repeat(MAX_LOG_LINE_BYTES);
        for _ in 0..(MAX_LOG_LINES + 10) {
            host.log(LogLevel::Info, &long);
        }
        host.log(LogLevel::Debug, "after the cap");
        host.log(LogLevel::Warn, "after the cap");
        host.log(LogLevel::Error, "after the cap");
        assert_eq!(host.log_lines.get(), MAX_LOG_LINES + 1);
    }

    #[test]
    fn tools_report_declared_resolved_and_missing() {
        let mut tools = HashMap::new();
        tools.insert("typst".to_string(), Some(PathBuf::from("/usr/bin/typst")));
        tools.insert("ghost".to_string(), None);
        let host = HostContext::new(
            CallSetup {
                permissions: vec![PERM_NATIVE_TOOLS.into()],
                native_tools: tools,
                ..CallSetup::default()
            },
            limits::WASM.resolve(None, None),
            limits::NATIVE_ALLOWANCE,
        );
        assert!(host.tool_available("typst").unwrap());
        assert!(!host.tool_available("ghost").unwrap());
        assert!(!host.tool_available("undeclared").unwrap());
        assert!(matches!(
            host.tool_run("ghost", ToolRunOptions::default()),
            Err(HostError::Unavailable(_))
        ));
        assert!(matches!(
            host.tool_run("undeclared", ToolRunOptions::default()),
            Err(HostError::Invalid(_))
        ));
        // Declared and found, but there is nowhere to run it.
        assert!(matches!(
            host.tool_run("typst", ToolRunOptions::default()),
            Err(HostError::Unavailable(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_tool_run_returns_text_or_base64() {
        let cat = PathBuf::from(if cfg!(target_os = "android") {
            "/system/bin/cat"
        } else {
            "/bin/cat"
        });
        if !cat.exists() {
            return;
        }
        let root = scratch();
        let host = HostContext::new(
            CallSetup {
                permissions: vec![PERM_NATIVE_TOOLS.into()],
                native_tools: HashMap::from([("cat".to_string(), Some(cat))]),
                data_root: Some(root.clone()),
                ..CallSetup::default()
            },
            limits::WASM.resolve(None, None),
            limits::NATIVE_ALLOWANCE,
        );
        let text = host
            .tool_run(
                "cat",
                ToolRunOptions {
                    stdin: Some("hello".into()),
                    ..ToolRunOptions::default()
                },
            )
            .unwrap();
        assert_eq!(text.stdout, "hello");
        assert_eq!(text.status_code, Some(0));
        assert!(text.stdout_base64.is_none());
        let binary = host
            .tool_run(
                "cat",
                ToolRunOptions {
                    stdin: Some("hi".into()),
                    output_base64: true,
                    ..ToolRunOptions::default()
                },
            )
            .unwrap();
        assert_eq!(binary.stdout, "");
        assert_eq!(binary.stdout_base64.as_deref(), Some("aGk="));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_cancelled_call_stops_at_its_next_check() {
        let host = ctx(&[], None);
        assert!(host.check().is_ok());
        host.cancel_token().cancel();
        assert!(matches!(host.check(), Err(HostError::Cancelled)));
    }

    #[test]
    fn an_expired_budget_stops_the_call() {
        let host = HostContext::new(
            CallSetup::default(),
            Limits {
                memory_bytes: 1,
                timeout: Duration::ZERO,
            },
            Duration::ZERO,
        );
        assert!(matches!(host.check(), Err(HostError::Budget)));
        assert_eq!(host.plugin_id(), "");
    }
}
