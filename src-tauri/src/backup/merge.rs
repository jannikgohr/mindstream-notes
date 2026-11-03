//! The merge import command. The merge itself lives in `storage-core`.

use super::*;

/// Merge missing items: copy rows from the staged DB into the live DB
/// when their `id` doesn't exist locally. Sync metadata is dropped on
/// every imported row (merge mode is always sanitize-by-design). No
/// restart needed.
#[tauri::command]
pub fn import_merge(
    app: AppHandle,
    db: tauri::State<'_, Db>,
    token: String,
) -> CommandResult<MergeReport> {
    let _job = app.state::<crate::vault_jobs::Jobs>().enter()?;
    let dir = portable::token_directory(&imports_staging_root(&app)?, &token)?;
    let staged = dir.join("data.db");
    if !staged.exists() {
        return Err(format!("staged backup '{token}' not found").into());
    }
    let backup_conn = Connection::open(&staged)?;
    let report = db.with_conn_mut(|live| Ok(merge_into(live, &backup_conn)?))?;
    // Merge consumed the staged DB; drop the dir so it doesn't linger.
    let _ = fs::remove_dir_all(&dir);
    Ok(report)
}
