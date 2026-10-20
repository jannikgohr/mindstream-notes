//! Native tools: finding a declared binary on PATH and running it once.
//!
//! A plugin names a tool by its manifest id. The manifest says which
//! executable basename that is, and the host resolves it on PATH itself and
//! starts it directly, never through a shell, so a plugin can only ever run
//! the exact binaries it declared.

use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::cancel::CancelToken;
use crate::error::{HostError, HostResult};

pub const MAX_ARGS: usize = 64;
pub const MAX_ARG_BYTES: usize = 4096;
pub const MAX_STDIN_BYTES: usize = 8 * 1024 * 1024;
/// Shortest and longest a single tool run may be given.
pub const MIN_TIMEOUT_MS: u64 = 100;
pub const MAX_TIMEOUT_MS: u64 = 30_000;
pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;

/// Refuse anything but a plain executable basename: no separators, no `..`,
/// and on Windows no extension other than `.exe`.
pub fn validate_binary_name(binary_name: &str) -> HostResult<()> {
    if binary_name.is_empty()
        || binary_name.contains('/')
        || binary_name.contains('\\')
        || binary_name.contains("..")
        || Path::new(binary_name)
            .extension()
            .is_some_and(|ext| !ext.to_string_lossy().eq_ignore_ascii_case("exe"))
        || !binary_name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
    {
        return Err(HostError::Invalid(format!(
            "unsafe native tool binary name '{binary_name}'"
        )));
    }
    Ok(())
}

/// The extensions to try for `binary_name` on this platform. Only `.exe` on
/// Windows, so a `.bat` or `.cmd` on PATH never runs through `cmd.exe`.
pub fn path_extensions(binary_name: &str) -> Vec<OsString> {
    #[cfg(windows)]
    {
        if Path::new(binary_name).extension().is_some() {
            return vec![OsString::new()];
        }
        let pathext = std::env::var_os("PATHEXT").unwrap_or_else(|| ".EXE".into());
        let mut out = std::env::split_paths(&pathext)
            .flat_map(|p| p.into_os_string().into_string().ok())
            .flat_map(|s| s.split(';').map(str::to_string).collect::<Vec<_>>())
            .filter(|s| s.eq_ignore_ascii_case(".exe"))
            .map(OsString::from)
            .collect::<Vec<_>>();
        if out.is_empty() {
            out.push(".exe".into());
        }
        out
    }
    #[cfg(not(windows))]
    {
        let _ = binary_name;
        vec![OsString::new()]
    }
}

/// The first file on PATH with this basename, or none.
pub fn resolve_path_binary(binary_name: &str) -> HostResult<Option<PathBuf>> {
    validate_binary_name(binary_name)?;
    let Some(path_var) = std::env::var_os("PATH") else {
        return Ok(None);
    };
    for dir in std::env::split_paths(&path_var) {
        for ext in path_extensions(binary_name) {
            let mut candidate = dir.join(binary_name);
            if !ext.is_empty() {
                candidate.set_extension(
                    ext.to_string_lossy()
                        .trim_start_matches('.')
                        .to_ascii_lowercase(),
                );
            }
            if candidate.is_file() {
                return Ok(Some(candidate));
            }
        }
    }
    Ok(None)
}

/// Windows `CREATE_NO_WINDOW`. A console-subsystem child (`tinymist`, `typst`,
/// ...) gets a console allocated purely because of its subsystem. Redirecting
/// stdio does not suppress it, so a GUI parent with no console of its own pops
/// a terminal window beside the app.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Keep a spawned child's console window hidden. No-op off Windows, where
/// nothing is allocated in the first place.
pub fn hide_console_window(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

pub fn validate_args(args: &[String], stdin: Option<&str>) -> HostResult<()> {
    if args.len() > MAX_ARGS {
        return Err(HostError::Invalid(format!(
            "native tool received too many arguments ({})",
            args.len()
        )));
    }
    for arg in args {
        if arg.len() > MAX_ARG_BYTES || arg.contains('\0') {
            return Err(HostError::Invalid(
                "native tool argument is too large or contains NUL".into(),
            ));
        }
    }
    if let Some(stdin) = stdin {
        if stdin.len() > MAX_STDIN_BYTES || stdin.contains('\0') {
            return Err(HostError::Invalid(
                "native tool stdin is too large or contains NUL".into(),
            ));
        }
    }
    Ok(())
}

/// A process result with the raw bytes. Kept binary so a tool that writes a
/// PDF or PNG survives. Text callers decode it lossily.
#[derive(Debug)]
pub struct RawToolOutput {
    pub status_code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
}

/// Run `binary` once in `cwd` and wait for it, at most `timeout_ms` (clamped
/// to 100 ms .. 30 s). A cancelled `cancel` kills the process and returns
/// [`HostError::Cancelled`].
pub fn run(
    binary: PathBuf,
    cwd: PathBuf,
    args: Vec<String>,
    stdin: Option<String>,
    timeout_ms: Option<u64>,
    cancel: Option<&CancelToken>,
) -> HostResult<RawToolOutput> {
    validate_args(&args, stdin.as_deref())?;
    fs::create_dir_all(&cwd)?;
    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    );
    let mut command = Command::new(binary);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = hide_console_window(&mut command).spawn()?;

    // Feed stdin and drain stdout/stderr on their own threads so all three
    // pipes make progress at once. Writing all of stdin first, or reading
    // stdout only after the child exits, deadlocks a child that writes more
    // than the OS pipe buffer (about 64 KiB, far less on Windows): it blocks in
    // `write()` and never exits. Native tools routinely stream large binary
    // stdout (`typst compile - -` writes a whole PDF), so this is the common
    // path, not an edge case.
    let stdin_writer = child.stdin.take().map(|mut pipe| {
        std::thread::spawn(move || {
            if let Some(input) = stdin {
                // A broken pipe (the child exited or never read stdin) is not
                // actionable here. The exit status tells the real story.
                let _ = pipe.write_all(input.as_bytes());
            }
            // Dropping `pipe` closes the child's stdin so a tool reading to
            // EOF can finish.
        })
    });
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        pipe.map(|mut pipe| {
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let _ = pipe.read_to_end(&mut buf);
                buf
            })
        })
    };
    let stdout_reader = drain(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let stderr_reader = drain(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );

    let start = Instant::now();
    let mut timed_out = false;
    let mut cancelled = false;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        cancelled = cancel.is_some_and(CancelToken::is_cancelled);
        if cancelled || start.elapsed() >= timeout {
            let _ = child.kill();
            timed_out = !cancelled;
            // Reap the killed child. The reader threads unblock as its pipe
            // write ends close.
            break child.wait()?;
        }
        std::thread::sleep(Duration::from_millis(10));
    };

    // Join the drainers now that the child has closed its pipes, so the full
    // output it produced comes back.
    let stdout = stdout_reader
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    let stderr = stderr_reader
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    if let Some(handle) = stdin_writer {
        let _ = handle.join();
    }
    if cancelled {
        return Err(HostError::Cancelled);
    }

    Ok(RawToolOutput {
        status_code: status.code(),
        stdout,
        stderr,
        timed_out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_names_are_exact_basenames() {
        assert!(validate_binary_name("typst").is_ok());
        assert!(validate_binary_name("typst.exe").is_ok());
        assert!(validate_binary_name("clang++").is_ok());
        for bad in [
            "",
            "../typst",
            "tools/typst",
            "tools\\typst",
            "ty..pst",
            "typst.cmd",
            "typst.bat",
            "ty pst",
        ] {
            assert!(validate_binary_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn extensions_are_offered_per_platform() {
        let exts = path_extensions("typst");
        assert!(!exts.is_empty());
        #[cfg(windows)]
        assert!(exts.iter().all(|e| e.eq_ignore_ascii_case(".exe")));
        #[cfg(not(windows))]
        assert_eq!(exts, vec![OsString::new()]);
    }

    #[test]
    fn an_unknown_binary_resolves_to_none_and_a_bad_name_errors() {
        assert!(resolve_path_binary("ms-not-a-real-binary-xyz")
            .unwrap()
            .is_none());
        assert!(resolve_path_binary("../sh").is_err());
    }

    #[test]
    fn arguments_and_stdin_are_bounded() {
        assert!(validate_args(&["a".into()], Some("in")).is_ok());
        let many = vec![String::new(); MAX_ARGS + 1];
        assert!(validate_args(&many, None).is_err());
        assert!(validate_args(&["x".repeat(MAX_ARG_BYTES + 1)], None).is_err());
        assert!(validate_args(&["nul\0".into()], None).is_err());
        assert!(validate_args(&[], Some("nul\0")).is_err());
        assert!(validate_args(&[], Some(&"x".repeat(MAX_STDIN_BYTES + 1))).is_err());
    }

    fn scratch() -> PathBuf {
        std::env::temp_dir().join(format!("ms-process-{}", uuid::Uuid::new_v4()))
    }

    #[cfg(unix)]
    fn sleeper() -> Option<PathBuf> {
        resolve_path_binary("sleep").ok().flatten()
    }

    #[cfg(unix)]
    #[test]
    fn a_cancelled_run_kills_the_process_promptly() {
        let Some(sleep) = sleeper() else { return };
        let cwd = scratch();
        let token = CancelToken::new();
        let canceller = token.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            canceller.cancel();
        });
        let started = Instant::now();
        let result = run(
            sleep,
            cwd.clone(),
            vec!["10".into()],
            None,
            Some(20_000),
            Some(&token),
        );
        assert!(matches!(result, Err(HostError::Cancelled)), "{result:?}");
        assert!(started.elapsed() < Duration::from_secs(5));
        fs::remove_dir_all(cwd).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_run_past_its_timeout_is_killed_and_marked() {
        let Some(sleep) = sleeper() else { return };
        let cwd = scratch();
        let out = run(sleep, cwd.clone(), vec!["10".into()], None, Some(100), None).unwrap();
        assert!(out.timed_out);
        fs::remove_dir_all(cwd).ok();
    }

    /// A tool that echoes stdin to stdout. `None` on a host without one, and
    /// the test below skips.
    #[cfg(unix)]
    fn stdin_echo_tool() -> Option<PathBuf> {
        let cat = PathBuf::from(if cfg!(target_os = "android") {
            "/system/bin/cat"
        } else {
            "/bin/cat"
        });
        cat.exists().then_some(cat)
    }
    #[cfg(windows)]
    fn stdin_echo_tool() -> Option<PathBuf> {
        resolve_path_binary("sort").ok().flatten()
    }

    #[test]
    fn large_output_is_drained_without_deadlock() {
        // Regression: the runner used to write all of stdin, then poll for exit
        // while draining stdout only after the child exited. A child writing
        // more than the OS pipe buffer blocked in `write()`, never exited, and
        // was killed at the timeout with its output lost, which silently broke
        // Typst PDF export.
        let Some(tool) = stdin_echo_tool() else {
            eprintln!("skipping: no stdin-echo tool on this platform");
            return;
        };
        // 256 KiB dwarfs any pipe buffer. Identical short lines keep `sort`'s
        // output the same size as its input.
        let payload = "abc\n".repeat(64 * 1024);
        let cwd = scratch();
        let out = run(
            tool,
            cwd.clone(),
            Vec::new(),
            Some(payload),
            Some(10_000),
            None,
        )
        .expect("running the echo tool succeeds");
        assert!(
            !out.timed_out,
            "output past the pipe buffer must not deadlock"
        );
        assert_eq!(out.status_code, Some(0));
        // A lower bound tolerates Windows `sort` rewriting line endings; it
        // still proves far more than one pipe buffer was drained.
        assert!(
            out.stdout.len() >= 128 * 1024,
            "expected the full stdout stream, got {} bytes",
            out.stdout.len()
        );
        fs::remove_dir_all(cwd).ok();
    }
}
