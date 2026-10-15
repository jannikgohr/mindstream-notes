//! Keeping a secret the user was just shown in a file they choose.
//!
//! A recovery key is shown once and cannot be shown again. Copying it is one
//! way to keep it, a file is another, and the one people ask for when they
//! have no password manager. The window builds the text, in the user's
//! language, and hands it over. This asks where it should go and writes it
//! where only the user's own account can read it, on systems that can say
//! so.
//!
//! The text is never logged, and the type that carries it has no `Debug`.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

use crate::error::{AppError, CommandResult};

/// More than any key or set of codes comes to, and little enough that the
/// command cannot be used to write a large file.
const MAX_BYTES: usize = 16 * 1024;
const FALLBACK_NAME: &str = "recovery-key.txt";

#[derive(Deserialize)]
pub struct SecretFileInput {
    /// The save dialog's title.
    pub title: String,
    /// What the dialog calls the kind of file, beside `*.txt`.
    pub kind: String,
    pub suggested_name: String,
    pub contents: String,
}

/// A file name and nothing more: no folder, no drive, nothing a file system
/// reads as anything but a name, and a `.txt` ending.
pub(crate) fn safe_file_name(suggested: &str) -> String {
    let stem = suggested
        .trim()
        .strip_suffix(".txt")
        .unwrap_or(suggested.trim());
    let cleaned: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches(|c| c == '.' || c == '-');
    if cleaned.is_empty() {
        return FALLBACK_NAME.to_string();
    }
    let cleaned: String = cleaned.chars().take(80).collect();
    format!("{cleaned}.txt")
}

/// Write the text so that only the owner of the file can read it. That is
/// the file's mode on Unix. Elsewhere the file gets what its folder gives
/// it, which on Windows is the user's own profile unless they chose
/// otherwise.
pub(crate) fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    // A file that was there already keeps the mode it had, so say it again.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(contents.as_bytes())?;
    file.sync_all()
}

/// Ask where to keep the secret and write it there. `false` when the user
/// closes the dialog without choosing, which is not an error.
#[tauri::command]
pub async fn account_save_secret_file(
    app: AppHandle,
    input: SecretFileInput,
) -> CommandResult<bool> {
    if input.contents.is_empty() || input.contents.len() > MAX_BYTES {
        return Err(AppError::InvalidArg("nothing to save, or too much".into()).into());
    }

    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_title(&input.title)
        .add_filter(&input.kind, &["txt"])
        .set_file_name(safe_file_name(&input.suggested_name))
        .set_can_create_directories(true)
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(chosen) = rx
        .await
        .map_err(|e| AppError::InvalidArg(format!("save dialog: {e}")))?
    else {
        return Ok(false);
    };
    let destination = chosen
        .into_path()
        .map_err(|e| AppError::InvalidArg(format!("path conversion: {e}")))?;

    let contents = input.contents;
    tauri::async_runtime::spawn_blocking(move || write_private(&destination, &contents))
        .await
        .map_err(|e| AppError::InvalidArg(format!("save task: {e}")))?
        .map_err(AppError::Io)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_name_is_a_name_and_nothing_else() {
        assert_eq!(
            safe_file_name("mindstream-recovery-key-ann.txt"),
            "mindstream-recovery-key-ann.txt"
        );
        // No way out of the folder the user picks, on any system.
        assert_eq!(safe_file_name("../../etc/passwd"), "etc-passwd.txt");
        assert_eq!(safe_file_name("C:\\Users\\x\\key"), "C--Users-x-key.txt");
        assert_eq!(safe_file_name("a/b.txt"), "a-b.txt");
        // Whatever a username may hold, the name stays plain.
        assert_eq!(safe_file_name("key für ann?.txt"), "key-f-r-ann.txt");
        assert_eq!(safe_file_name("  "), FALLBACK_NAME);
        assert_eq!(safe_file_name("..."), FALLBACK_NAME);
        assert_eq!(safe_file_name(".txt"), FALLBACK_NAME);
        // Never without the ending, and never with two.
        assert_eq!(safe_file_name("key"), "key.txt");
        assert_eq!(safe_file_name("key.txt"), "key.txt");
        assert!(safe_file_name(&"k".repeat(500)).len() <= 84);
    }

    #[test]
    fn writes_the_text_and_replaces_what_was_there() {
        let dir = std::env::temp_dir().join(format!(
            "mindstream-secret-file-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("key.txt");

        std::fs::write(&path, "an older and much longer text that was here").unwrap();
        write_private(&path, "ABCD-EFGH").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "ABCD-EFGH");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "only the owner may read it");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
