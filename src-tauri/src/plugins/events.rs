//! Delivers note events to plugins in the backend. Mirror of
//! `src/lib/plugins/note-events.ts`; the cursor and settling rules are shared
//! in `storage-core`'s `note_events`.

use std::time::Duration;

use mindstream_storage_core::note_events;
use tauri::{AppHandle, Manager};

use super::{discovery, load_runnable, manifest, run_export, settings, PERM_NOTES_WATCH};
use crate::db::Db;
use crate::error::AppResult;

/// `TICK_MS` and `BATCH` in note-events.ts.
const TICK: Duration = Duration::from_secs(1);
const BATCH: u32 = 50;

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(TICK).await;
            if let Err(err) = deliver(&app).await {
                log::debug!("[plugins] note events paused: {err}");
            }
        }
    });
}

struct Subscription {
    plugin_id: String,
    event: manifest::NoteEventDecl,
    settings: serde_json::Value,
}

/// Enabled, approved plugins granted `notes.watch`. A plugin waiting for
/// approval keeps its cursor until it can run again.
fn subscriptions(app: &AppHandle) -> AppResult<Vec<Subscription>> {
    let db = app.state::<Db>();
    let third_party_dir = discovery::third_party_plugins_dir(app)?;
    let root = crate::paths::app_data_root(app)?;
    let vault = crate::paths::app_data_dir(app)?;
    db.with_conn(|conn| {
        let mut out = Vec::new();
        for record in super::list(conn)? {
            if !record.enabled
                || !record
                    .granted_permissions
                    .iter()
                    .any(|p| p == PERM_NOTES_WATCH)
            {
                continue;
            }
            let Ok((_, plugin)) = load_runnable(conn, &third_party_dir, &record.id, None) else {
                continue;
            };
            let values = settings::with_defaults(
                &plugin,
                settings::effective(&root, &vault, conn, &plugin)?,
            );
            let settings = serde_json::to_value(values)
                .map_err(|e| crate::error::AppError::InvalidArg(e.to_string()))?;
            for event in &plugin.manifest.contributes.note_events {
                out.push(Subscription {
                    plugin_id: record.id.clone(),
                    event: event.clone(),
                    settings: settings.clone(),
                });
            }
        }
        Ok(out)
    })
}

fn runnable(app: &AppHandle, plugin_id: &str) -> bool {
    let Ok(third_party_dir) = discovery::third_party_plugins_dir(app) else {
        return false;
    };
    app.state::<crate::vault_jobs::Jobs>().enter().is_ok()
        && app
            .state::<Db>()
            .with_conn(|conn| load_runnable(conn, &third_party_dir, plugin_id, None))
            .is_ok()
}

/// One pass over every subscription. A handler that fails still moves the
/// cursor: the event was delivered, and retrying it would block the plugin.
async fn deliver(app: &AppHandle) -> AppResult<()> {
    // Held for the pass, so pausing vault work waits for it, and a paused
    // vault skips the pass instead of failing every event.
    let Ok(_job) = app.state::<crate::vault_jobs::Jobs>().enter() else {
        return Ok(());
    };
    for Subscription {
        plugin_id,
        event,
        settings,
    } in subscriptions(app)?
    {
        let db = app.state::<Db>();
        let pending = db.with_conn(|conn| {
            Ok(note_events::pending(
                conn,
                &plugin_id,
                &event.export,
                &settings,
                event.note_kinds.as_deref(),
                event.settle_ms.unwrap_or(0),
                BATCH,
            )?)
        })?;
        for change in pending.changes {
            let input = serde_json::to_value(&change)
                .map_err(|e| crate::error::AppError::InvalidArg(e.to_string()))?;
            if let Err(err) = run_export(app, plugin_id.clone(), event.export.clone(), input).await
            {
                // The export never ran: the plugin was turned off or needs
                // approval, or vault work paused. Keep the event for later.
                if !runnable(app, &plugin_id) {
                    break;
                }
                log::warn!(
                    "[plugins] {plugin_id} {} failed for {}: {err}",
                    event.export,
                    change.note_id
                );
            }
            db.with_conn(|conn| {
                Ok(note_events::commit(
                    conn,
                    &plugin_id,
                    &event.export,
                    &pending.generation,
                    change.revision,
                )?)
            })?;
        }
    }
    Ok(())
}
