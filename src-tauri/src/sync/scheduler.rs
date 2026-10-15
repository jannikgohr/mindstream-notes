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
use tokio::sync::{Mutex, MutexGuard, Notify};

use crate::app_events::AppEvent;
use crate::auth;
use crate::db::Db;
use crate::error::{CommandError, CommandErrorCode, CommandResult};

use super::{catch_blocking_panic, preflight_reachable, SyncCompletedEvent};

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
    /// Wakes the loop for a sync ahead of schedule. A request that arrives
    /// while a sync is running is kept, so what changed mid-sync is fetched
    /// by the one that follows. Any number of requests in that time make
    /// one sync, not one each.
    wake: Notify,
    /// Whether the last sync reached the server. While it did not, or none
    /// has run yet, a sync starts with the quick reachability probe.
    server_reached: AtomicBool,
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
            wake: Notify::new(),
            server_reached: AtomicBool::new(false),
        }
    }

    /// Whether the last sync reached the server, see
    /// [`super::preflight_reachable`].
    pub(crate) fn server_reached(&self) -> bool {
        self.server_reached.load(Ordering::Relaxed)
    }

    pub(crate) fn set_server_reached(&self, reached: bool) {
        self.server_reached.store(reached, Ordering::Relaxed);
    }

    /// Whether the user has scheduled sync on.
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Ask for a sync now instead of at the next tick. Does nothing while
    /// scheduled sync is off: the user turned it off.
    pub fn request_sync(&self) {
        self.wake.notify_one();
    }

    /// Resolves at the next tick, or sooner when a sync was asked for.
    async fn next_tick(&self, interval: Duration) {
        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            _ = self.wake.notified() => {}
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

            scheduler.next_tick(Duration::from_secs(interval)).await;
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
    // Signed out is an ordinary resting state — a local-only vault never
    // has a session — not a failure worth logging every cycle. The JS side
    // gates the schedule on the session too, but this is the authoritative
    // check: a sign-out races the settings effect, and `enabled` is
    // process-wide state that outlives any one window.
    //
    // Checked ahead of the reachability probe so a signed-out install
    // isn't pinging the server on every tick for a sync it can't run.
    if !auth::has_session(app) {
        return Ok(());
    }

    // Reachability preflight, while it is not known that the server is
    // there. When the server is unreachable the probe emits a one-shot
    // `sync-unreachable` notification; skip the tick quietly rather than
    // logging a hard failure (and firing doomed requests) every cycle
    // while offline.
    let scheduler = app.state::<SyncScheduler>();
    if !scheduler.server_reached() && !preflight_reachable(app).await {
        return Ok(());
    }

    let app_for_blocking = app.clone();
    let delta = tauri::async_runtime::spawn_blocking(move || {
        catch_blocking_panic("sync-scheduler", || {
            let account = auth::try_restore(&app_for_blocking)
                .map_err(|e| format!("restore session: {e}"))?
                .ok_or_else(|| "not signed in".to_string())?;
            let self_username = auth::read_session_info(&app_for_blocking)
                .ok()
                .flatten()
                .map(|info| info.username);
            let db = app_for_blocking.state::<Db>();
            super::run_session(&app_for_blocking, &db, &account, self_username.as_deref())
        })
    })
    .await
    .map_err(|e| format!("sync task: {e}"))??;
    scheduler.set_server_reached(delta.is_some());
    // The server went away between two syncs. The UI has been told, and
    // the next tick asks with the probe.
    let Some(delta) = delta else {
        return Ok(());
    };

    let event = SyncCompletedEvent {
        report: delta.report,
        notes_pulled_ids: delta.notes_pulled_ids,
        assets_pulled_ids: delta.assets_pulled_ids,
        limits: delta.limits,
    };
    let event_name = AppEvent::SyncCompleted.as_str();
    if let Err(err) = app.emit(event_name, &event) {
        log::warn!("[sync-scheduler] failed to emit {event_name}: {err}");
    }
    Ok(())
}

// ---------- Tauri commands ----------

#[tauri::command]
pub fn set_sync_schedule(
    scheduler: State<'_, SyncScheduler>,
    enabled: bool,
    interval_secs: u64,
) -> CommandResult<()> {
    apply_sync_schedule(&scheduler, enabled, interval_secs)
}

fn apply_sync_schedule(
    scheduler: &SyncScheduler,
    enabled: bool,
    interval_secs: u64,
) -> CommandResult<()> {
    let interval = validate_sync_schedule(enabled, interval_secs)?;
    scheduler.enabled.store(enabled, Ordering::Relaxed);
    if let Some(interval_secs) = interval {
        scheduler
            .interval_secs
            .store(interval_secs, Ordering::Relaxed);
    }
    Ok(())
}

fn validate_sync_schedule(enabled: bool, interval_secs: u64) -> CommandResult<Option<u64>> {
    if enabled && interval_secs == 0 {
        return Err(CommandError::new(
            CommandErrorCode::InvalidArgument,
            "enabled sync schedule requires a positive interval",
        ));
    }
    Ok((interval_secs > 0).then_some(interval_secs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_sync_schedule_updates_enabled_state_and_interval() {
        let scheduler = SyncScheduler::new();

        apply_sync_schedule(&scheduler, true, 120).unwrap();

        assert!(scheduler.enabled.load(Ordering::Relaxed));
        assert_eq!(scheduler.interval_secs.load(Ordering::Relaxed), 120);
    }

    #[test]
    fn disabled_zero_interval_preserves_previous_interval() {
        let scheduler = SyncScheduler::new();
        apply_sync_schedule(&scheduler, true, 300).unwrap();

        apply_sync_schedule(&scheduler, false, 0).unwrap();

        assert!(!scheduler.enabled.load(Ordering::Relaxed));
        assert_eq!(scheduler.interval_secs.load(Ordering::Relaxed), 300);
    }

    #[tokio::test(start_paused = true)]
    async fn sync_asked_for_does_not_wait_for_the_tick() {
        let scheduler = SyncScheduler::new();
        let hour = Duration::from_secs(3600);

        // Nothing asked: the tick takes its full time.
        let started = tokio::time::Instant::now();
        scheduler.next_tick(hour).await;
        assert_eq!(started.elapsed(), hour);

        // Asked while nothing was waiting, as when a sync is running: kept
        // for the next wait, however many times it was asked.
        scheduler.request_sync();
        scheduler.request_sync();
        let started = tokio::time::Instant::now();
        scheduler.next_tick(hour).await;
        assert_eq!(started.elapsed(), Duration::ZERO);
        // And spent by it.
        scheduler.next_tick(hour).await;
        assert_eq!(started.elapsed(), hour);
    }

    #[test]
    fn enabled_zero_interval_is_rejected_without_mutating_state() {
        let scheduler = SyncScheduler::new();

        let err = apply_sync_schedule(&scheduler, true, 0).unwrap_err();

        assert_eq!(err.code, CommandErrorCode::InvalidArgument);
        assert!(!scheduler.enabled.load(Ordering::Relaxed));
        assert_eq!(
            scheduler.interval_secs.load(Ordering::Relaxed),
            DEFAULT_INTERVAL_SECS
        );
    }
}
