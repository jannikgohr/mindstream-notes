//! Periodic sync scheduler — Rust-side tokio loop that replaces the
//! `setTimeout` self-rescheduler that used to live in `+layout.svelte`.
//!
//! Why move it: the JS timer pauses if the event loop gets blocked
//! (long Crepe operation, complex drawing paint) and is subject to
//! background-throttling rules on mobile webviews. A Rust task ticks
//! on its own thread regardless of what JS is doing, gives us a
//! single schedule per process even with multiple windows, and lets
//! us log slip / latency in one place.
//!
//! The schedule is JS-driven via `set_sync_schedule({ enabled, seconds })`
//! — the settings UI calls it whenever `account.syncEnabled` /
//! `account.syncInterval` change. Initial values land via the same
//! command at app start (the JS `$effect` fires once with the
//! restored localStorage values).
//!
//! Coalescing with manual `sync_now`: both the scheduler and the
//! Tauri command acquire `in_flight` before running, so a user-clicked
//! sync that lands while a scheduler tick is mid-flight just waits a
//! moment for the running one to finish. There's no need to "share"
//! the in-flight task — the second sync runs immediately after, and
//! Etebase stoken-paged pulls are cheap when nothing changed.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{Mutex, MutexGuard};

use crate::auth;
use crate::db::Db;

use super::{catch_blocking_panic, run, SyncCompletedEvent, SYNC_COMPLETED_EVENT};

/// Default tick interval (seconds) before the JS side hydrates the
/// schedule from settings. 30s matches the previous JS `'live'`
/// default — short enough to feel fresh, long enough to not hammer
/// the server during the brief startup window.
const DEFAULT_INTERVAL_SECS: u64 = 30;

/// Polling cadence used when sync is disabled — we still wake every
/// few seconds to notice if the user just enabled it. Cheap.
const DISABLED_POLL_SECS: u64 = 5;

pub struct SyncScheduler {
    enabled: AtomicBool,
    interval_secs: AtomicU64,
    /// Serialises sync attempts. Acquired both by the scheduler tick
    /// and by `sync_now` so the two can't run concurrently and
    /// double-push the same dirty rows or compete for the etebase
    /// stoken.
    in_flight: Mutex<()>,
}

impl SyncScheduler {
    pub fn new() -> Self {
        Self {
            // Start disabled. The JS settings effect fires once on
            // mount and pushes the restored preference; starting
            // enabled would race against that and could fire a sync
            // before the user even sees the app.
            enabled: AtomicBool::new(false),
            interval_secs: AtomicU64::new(DEFAULT_INTERVAL_SECS),
            in_flight: Mutex::new(()),
        }
    }

    /// Acquire the sync-in-flight lock. The scheduler tick and the
    /// `sync_now` Tauri command both call this so they serialise on
    /// the same mutex — manual + scheduled can't race.
    pub async fn acquire_in_flight(&self) -> MutexGuard<'_, ()> {
        self.in_flight.lock().await
    }
}

impl Default for SyncScheduler {
    fn default() -> Self {
        Self::new()
    }
}

/// Spawn the periodic loop. Called once during `setup`. The loop runs
/// for the lifetime of the app — Tauri tears the runtime down on exit
/// which drops the task; any in-progress sync is interrupted, which
/// is safe (etebase calls are transactional).
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let scheduler = app.state::<SyncScheduler>();
            let enabled = scheduler.enabled.load(Ordering::Relaxed);
            let interval = scheduler.interval_secs.load(Ordering::Relaxed).max(1);

            if !enabled {
                tokio::time::sleep(Duration::from_secs(DISABLED_POLL_SECS)).await;
                continue;
            }

            // Hold the mutex for the whole sync so a parallel
            // `sync_now` waits cleanly.
            {
                let _guard = scheduler.acquire_in_flight().await;
                if let Err(err) = tick(&app).await {
                    log::warn!("[sync-scheduler] tick failed: {err}");
                }
            }

            tokio::time::sleep(Duration::from_secs(interval)).await;
        }
    });
}

/// One sync attempt. Identical body to `sync_now` minus the Tauri
/// command wrapper — we call `run()` on a blocking thread (etebase
/// uses blocking IO) and emit the `sync-completed` event with the
/// same payload schema as the manual command, so JS subscribers see
/// no difference between scheduler-triggered and user-triggered
/// syncs.
async fn tick(app: &AppHandle) -> Result<(), String> {
    let app_for_blocking = app.clone();
    let delta = tauri::async_runtime::spawn_blocking(move || {
        catch_blocking_panic("sync-scheduler", || {
            let account = auth::try_restore(&app_for_blocking)
                .map_err(|e| format!("restore session: {e}"))?
                .ok_or_else(|| "not signed in".to_string())?;
            let db = app_for_blocking.state::<Db>();
            run(&db, &account).map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| format!("sync task: {e}"))??;

    let event = SyncCompletedEvent {
        report: delta.report,
        notes_pulled_ids: delta.notes_pulled_ids,
        assets_pulled_ids: delta.assets_pulled_ids,
    };
    if let Err(err) = app.emit(SYNC_COMPLETED_EVENT, &event) {
        log::warn!("[sync-scheduler] failed to emit {SYNC_COMPLETED_EVENT}: {err}");
    }
    Ok(())
}

// ---------- Tauri commands ----------

#[tauri::command]
pub fn set_sync_schedule(scheduler: State<'_, SyncScheduler>, enabled: bool, interval_secs: u64) {
    scheduler.enabled.store(enabled, Ordering::Relaxed);
    if interval_secs > 0 {
        scheduler
            .interval_secs
            .store(interval_secs, Ordering::Relaxed);
    }
}
