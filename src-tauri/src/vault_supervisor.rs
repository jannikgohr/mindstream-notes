//! Supervised runtime integration. Startup remains opt-in while platform
//! menu/handoff and platform release checks are being completed.
use std::collections::BTreeMap;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use uuid::Uuid;

use crate::coordinator_ipc::{self as ipc, Endpoint, Request, Running};
use crate::error::{AppError, AppResult, CommandResult};
use crate::vault_runtime::Role;
use crate::worker_registration::RuntimeContract;

#[derive(Deserialize, Serialize)]
#[serde(tag = "command", rename_all = "camelCase", deny_unknown_fields)]
enum HostCommand {
    Activate,
    Status,
    WindowState {
        vault_id: String,
        launch_id: Uuid,
    },
    Focused {
        vault_id: String,
        launch_id: Uuid,
        window: String,
    },
    Open {
        vault_id: String,
    },
    OpenFromWindow {
        source_vault_id: String,
        launch_id: Uuid,
        vault_id: String,
    },
    HandoffFromWindow {
        source_vault_id: String,
        launch_id: Uuid,
        vault_id: String,
    },
    PickerOpen {
        vault_id: String,
    },
    OpenStatus {
        operation_id: Uuid,
    },
    Shortcut {
        command_id: crate::hotkeys::GlobalShortcutCommandId,
        #[serde(default)]
        accelerator: Option<String>,
    },
    Tray {
        action: crate::shortcut_actions::TrayCommand,
    },
    /// An invite link opened outside the app, for the vault used last.
    InviteLink {
        link: String,
    },
    ShortcutRegistrationStatus,
    Autostart {
        vault_id: String,
        launch_id: Uuid,
        enabled: Option<bool>,
    },
    UpdateCheck {
        vault_id: String,
        launch_id: Uuid,
        force: bool,
    },
    UpdateCheckStatus {
        operation_id: Uuid,
    },
    UpdateInstall {
        vault_id: String,
        launch_id: Uuid,
        update_id: Uuid,
    },
    AutostartStatus {
        operation_id: Uuid,
    },
    Quit,
    DeviceSettingsChanged {
        vault_id: String,
        launch_id: Uuid,
    },
    Authorize {
        vault_id: String,
        launch_id: Uuid,
        coordinator_id: Uuid,
        contract: RuntimeContract,
    },
    AuthorizeAdoption {
        vault_id: String,
        launch_id: Uuid,
        coordinator_id: Uuid,
        contract: RuntimeContract,
    },
    Register {
        vault_id: String,
        launch_id: Uuid,
        endpoint: Endpoint,
        contract: RuntimeContract,
    },
    Ready {
        vault_id: String,
        launch_id: Uuid,
    },
    StartupFailed {
        vault_id: String,
        launch_id: Uuid,
        message: String,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "command", rename_all = "camelCase", deny_unknown_fields)]
enum WorkerCommand {
    #[cfg(any(debug_assertions, feature = "e2e-data-dir"))]
    TestWindowFocus {
        launch_id: Uuid,
    },
    #[cfg(any(debug_assertions, feature = "e2e-data-dir"))]
    TestCloseFailure {
        launch_id: Uuid,
    },
    #[cfg(any(debug_assertions, feature = "e2e-data-dir"))]
    TestHoldJob {
        launch_id: Uuid,
        seconds: u64,
    },
    Activate {
        #[serde(default)]
        window: Option<String>,
    },
    Identify {
        launch_id: Uuid,
    },
    Adopt {
        launch_id: Uuid,
        host: Endpoint,
        contract: crate::worker_registration::RuntimeContract,
    },
    Close {
        launch_id: Uuid,
    },
    CaptureFailed {
        launch_id: Uuid,
        message: String,
    },
    Tray {
        launch_id: Uuid,
        action: crate::shortcut_actions::TrayCommand,
    },
    InviteLink {
        launch_id: Uuid,
        link: String,
    },
    QuitFailed {
        launch_id: Uuid,
        message: String,
    },
    CloseStatus {
        launch_id: Uuid,
        operation_id: Uuid,
    },
    CancelClose {
        launch_id: Uuid,
        operation_id: Uuid,
    },
    SnapshotWindows {
        launch_id: Uuid,
    },
    RestoreWindows {
        launch_id: Uuid,
        vault: crate::update_recovery::Vault,
    },
    RestoreStatus {
        launch_id: Uuid,
        operation_id: Uuid,
    },
    UpdateProgress {
        launch_id: Uuid,
        progress: crate::coordinator_updater::DownloadProgress,
    },
    RefreshDeviceSettings {
        launch_id: Uuid,
    },
    Shortcut {
        launch_id: Uuid,
        command_id: crate::hotkeys::GlobalShortcutCommandId,
        accelerator: Option<String>,
    },
}

struct Launch {
    id: Uuid,
    endpoint: Option<Endpoint>,
    ready: bool,
    activate_on_ready: bool,
    error: Option<String>,
    adopted: bool,
    focused_window: Option<String>,
}
struct Operation {
    input: Value,
    reply: Value,
    at: Instant,
    open_result: Option<Result<(), String>>,
    autostart_result: Option<Result<bool, String>>,
    update_result: Option<crate::coordinator_updater::CheckProgress>,
}
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase", deny_unknown_fields)]
enum AutostartProgress {
    Pending,
    Ready { enabled: bool },
    Failed { message: String },
}
#[derive(Deserialize, Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase", deny_unknown_fields)]
enum OpenProgress {
    Pending,
    Ready,
    Failed { message: String },
}
#[derive(Default)]
struct Book {
    exported: bool,
    had_ready_worker: bool,
    recovering: bool,
    quitting: Option<Uuid>,
    handoff: Option<Uuid>,
    bootstrap_started: bool,
    activate_after_startup: bool,
    picker_open: bool,
    /// An invite link that arrived before a vault could take it: during
    /// startup, recovery or with only the picker open. The newest wins.
    pending_invite_link: Option<String>,
    last: Option<String>,
    workers: BTreeMap<String, Launch>,
    operations: BTreeMap<Uuid, Operation>,
    focus_order: Vec<String>,
    shortcut_order: Vec<String>,
    focus_revision: u64,
    /// A failed update session was kept for one retry on the next launch.
    update_retry: bool,
    handoff_failures: u32,
    handoff_failing_since: Option<Instant>,
    handoff_retry_at: Option<Instant>,
}

enum Action {
    Quit,
    Open(String),
    Initialize {
        vault_id: String,
    },
    ShowPicker,
    Handoff {
        source: String,
        launch_id: Uuid,
        target: String,
    },
    ActivateLast,
    RetryRecovery,
    Remember {
        vault_id: String,
        revision: u64,
    },
    RefreshDeviceSettings,
    Shortcut(crate::hotkeys::GlobalShortcutCommandId, Option<String>),
    Tray(crate::shortcut_actions::TrayCommand),
    InviteLink(String),
    Autostart(Option<bool>),
    UpdateCheck(bool),
    UpdateInstall(Uuid),
}

impl Book {
    fn handoff_settled(&mut self) {
        self.handoff_failures = 0;
        self.handoff_failing_since = None;
        self.handoff_retry_at = None;
    }

    /// Record a failed automatic retry and schedule the next one. True once
    /// the intent has used its retries or the overall recovery limit.
    fn handoff_failed(&mut self, now: Instant) -> bool {
        self.handoff_failures += 1;
        let since = *self.handoff_failing_since.get_or_insert(now);
        self.handoff_retry_at = Some(now + Duration::from_secs(5) * self.handoff_failures);
        self.handoff_failures >= HANDOFF_RETRIES || now.duration_since(since) >= RECOVERY_LIMIT
    }

    fn startup_failed(&mut self, operation_id: Option<Uuid>, error: AppError) {
        // Once export/discovery completed, retry through normal opening. Before
        // that point release the initialization reservation for the picker.
        self.bootstrap_started = self.exported;
        if let Some(id) = operation_id {
            self.complete_open(id, Err(error));
        }
    }
    fn window_state(
        &self,
        vault_id: &str,
        launch_id: Uuid,
    ) -> AppResult<crate::vault_window_state::View> {
        let source = self.workers.get(vault_id).ok_or_else(invalid)?;
        if !self.exported
            || source.id != launch_id
            || !source.ready
            || source.endpoint.is_none()
            || source.error.is_some()
        {
            return Err(invalid());
        }
        Ok(crate::vault_window_state::View {
            supervised: true,
            vaults: self
                .workers
                .iter()
                .map(|(id, launch)| crate::vault_window_state::Entry {
                    vault_id: id.clone(),
                    status: if launch.error.is_some() {
                        crate::vault_window_state::Status::Unavailable
                    } else if launch.ready && launch.endpoint.is_some() {
                        crate::vault_window_state::Status::Ready
                    } else {
                        crate::vault_window_state::Status::Starting
                    },
                })
                .collect(),
        })
    }
    fn autostart_status(&self, id: Uuid) -> AppResult<AutostartProgress> {
        let operation = self.operations.get(&id).ok_or_else(invalid)?;
        if operation.input["command"].as_str() != Some("autostart") {
            return Err(invalid());
        }
        Ok(match &operation.autostart_result {
            None => AutostartProgress::Pending,
            Some(Ok(enabled)) => AutostartProgress::Ready { enabled: *enabled },
            Some(Err(message)) => AutostartProgress::Failed {
                message: message.clone(),
            },
        })
    }

    fn complete_autostart(&mut self, id: Uuid, result: AppResult<bool>) {
        if let Some(operation) = self.operations.get_mut(&id) {
            if operation.input["command"].as_str() == Some("autostart")
                && operation.autostart_result.is_none()
            {
                operation.autostart_result = Some(result.map_err(|error| error.to_string()));
            }
        }
    }

    fn idle_exit_candidate(&self, jobs: &crate::vault_jobs::Jobs) -> bool {
        self.exported
            && self.had_ready_worker
            && !self.recovering
            && self.workers.is_empty()
            && self.quitting.is_none()
            && self.handoff.is_none()
            && !self.picker_open
            && jobs.is_idle()
    }

    fn open_status(&self, operation_id: Uuid) -> AppResult<OpenProgress> {
        let operation = self.operations.get(&operation_id).ok_or_else(invalid)?;
        if !matches!(
            operation.input["command"].as_str(),
            Some(
                "open"
                    | "openFromWindow"
                    | "handoffFromWindow"
                    | "pickerOpen"
                    | "shortcut"
                    | "tray"
                    | "quit"
                    | "updateInstall"
            )
        ) {
            return Err(invalid());
        }
        Ok(match &operation.open_result {
            None => OpenProgress::Pending,
            Some(Ok(())) => OpenProgress::Ready,
            Some(Err(message)) => OpenProgress::Failed {
                message: message.clone(),
            },
        })
    }

    fn complete_open(&mut self, operation_id: Uuid, result: AppResult<()>) {
        let result = result.map_err(|error| error.to_string());
        let id = operation_id.to_string();
        for (request_id, operation) in &mut self.operations {
            let quit_alias = operation.input["command"].as_str() == Some("quit")
                && operation.reply["operation_id"].as_str() == Some(id.as_str());
            if (*request_id == operation_id || quit_alias)
                && matches!(
                    operation.input["command"].as_str(),
                    Some(
                        "open"
                            | "openFromWindow"
                            | "handoffFromWindow"
                            | "pickerOpen"
                            | "shortcut"
                            | "tray"
                            | "quit"
                            | "updateInstall"
                    )
                )
                && operation.open_result.is_none()
            {
                operation.open_result = Some(result.clone());
            }
        }
    }

    fn ready_endpoint(
        &self,
        vault_id: &str,
        launch_id: Uuid,
    ) -> AppResult<Option<(Endpoint, Option<String>)>> {
        let launch = self.workers.get(vault_id).ok_or_else(|| {
            AppError::InvalidArg("vault worker exited before opening completed".into())
        })?;
        if launch.id != launch_id {
            return Err(AppError::InvalidArg(
                "vault worker changed during opening".into(),
            ));
        }
        if let Some(error) = &launch.error {
            return Err(AppError::InvalidArg(error.clone()));
        }
        if !launch.ready {
            return Ok(None);
        }
        Ok(Some((
            launch.endpoint.clone().ok_or_else(invalid)?,
            launch.focused_window.clone(),
        )))
    }

    fn device_targets(&self) -> Vec<(Uuid, Endpoint)> {
        self.workers
            .values()
            .filter_map(|launch| {
                if !launch.ready || launch.error.is_some() {
                    return None;
                }
                launch
                    .endpoint
                    .clone()
                    .map(|endpoint| (launch.id, endpoint))
            })
            .collect()
    }
    fn remove_launch(&mut self, vault_id: &str, launch_id: Uuid) {
        if self
            .workers
            .get(vault_id)
            .is_some_and(|launch| launch.id == launch_id)
        {
            self.workers.remove(vault_id);
            self.focus_order.retain(|id| id != vault_id);
            if self.last.as_deref() == Some(vault_id) {
                self.last = self.focus_order.last().cloned();
            }
        }
    }

    fn accept(&mut self, instance: Uuid, request: Request) -> AppResult<(Value, Option<Action>)> {
        let command: HostCommand =
            serde_json::from_value(request.payload.clone()).map_err(|_| invalid())?;
        self.operations.retain(|id, operation| {
            self.quitting == Some(*id)
                || self.handoff == Some(*id)
                || operation.at.elapsed() < Duration::from_secs(600)
        });
        if let Some(operation) = self.operations.get(&request.id) {
            if operation.input != request.payload {
                return Err(invalid());
            }
            return Ok((operation.reply.clone(), None));
        }
        if let HostCommand::WindowState {
            vault_id,
            launch_id,
        } = &command
        {
            return Ok((
                serde_json::to_value(self.window_state(vault_id, *launch_id)?)
                    .map_err(|_| invalid())?,
                None,
            ));
        }
        if let HostCommand::OpenStatus { operation_id } = command {
            return Ok((
                serde_json::to_value(self.open_status(operation_id)?).map_err(|_| invalid())?,
                None,
            ));
        }
        if let HostCommand::UpdateCheckStatus { operation_id } = command {
            let operation = self.operations.get(&operation_id).ok_or_else(invalid)?;
            if operation.input["command"].as_str() != Some("updateCheck") {
                return Err(invalid());
            }
            return Ok((
                serde_json::to_value(
                    operation
                        .update_result
                        .as_ref()
                        .unwrap_or(&crate::coordinator_updater::CheckProgress::Pending),
                )
                .map_err(|_| invalid())?,
                None,
            ));
        }
        if let HostCommand::AutostartStatus { operation_id } = command {
            return Ok((
                serde_json::to_value(self.autostart_status(operation_id)?)
                    .map_err(|_| invalid())?,
                None,
            ));
        }
        if let Some(operation_id) = self.quitting {
            if matches!(command, HostCommand::Quit) {
                if self.operations.get(&operation_id).is_some_and(|operation| {
                    operation.input["command"].as_str() == Some("updateInstall")
                }) {
                    return Err(AppError::InvalidArg(
                        "the app is installing an update".into(),
                    ));
                }
                if self.operations.len() >= 1024 {
                    return Err(invalid());
                }
                let reply = json!({"accepted":true,"operation_id":operation_id});
                self.operations.insert(
                    request.id,
                    Operation {
                        input: request.payload,
                        reply: reply.clone(),
                        at: Instant::now(),
                        open_result: None,
                        autostart_result: None,
                        update_result: None,
                    },
                );
                return Ok((reply, None));
            }
            if matches!(
                command,
                HostCommand::Open { .. }
                    | HostCommand::OpenFromWindow { .. }
                    | HostCommand::HandoffFromWindow { .. }
                    | HostCommand::PickerOpen { .. }
                    | HostCommand::Activate
                    | HostCommand::Shortcut { .. }
                    | HostCommand::Tray { .. }
                    | HostCommand::InviteLink { .. }
                    | HostCommand::Autostart { .. }
                    | HostCommand::UpdateCheck { .. }
                    | HostCommand::UpdateInstall { .. }
            ) {
                return Err(AppError::InvalidArg(
                    "the app is quitting; no new vault action was started".into(),
                ));
            }
        }
        if self.handoff.is_some()
            && matches!(
                command,
                HostCommand::Open { .. }
                    | HostCommand::OpenFromWindow { .. }
                    | HostCommand::HandoffFromWindow { .. }
                    | HostCommand::PickerOpen { .. }
                    | HostCommand::Activate
                    | HostCommand::Shortcut { .. }
                    | HostCommand::Tray { .. }
                    | HostCommand::InviteLink { .. }
                    | HostCommand::Quit
                    | HostCommand::UpdateCheck { .. }
                    | HostCommand::UpdateInstall { .. }
            )
        {
            return Err(AppError::InvalidArg(
                "a vault handoff is in progress; no other window action was started".into(),
            ));
        }
        if self.exported
            && self.recovering
            && matches!(
                command,
                HostCommand::Open { .. }
                    | HostCommand::OpenFromWindow { .. }
                    | HostCommand::HandoffFromWindow { .. }
                    | HostCommand::PickerOpen { .. }
                    | HostCommand::Shortcut { .. }
                    | HostCommand::Tray { .. }
            )
        {
            return Err(AppError::InvalidArg(
                "startup recovery is still running; try opening the vault again shortly".into(),
            ));
        }
        if let HostCommand::DeviceSettingsChanged { vault_id, .. } = &command {
            // Slider/toolbar edits must not consume the mutation replay budget.
            // Retain the latest notice per source; older repeats are harmless
            // invalidations that reload canonical documents.
            self.operations.retain(|_, operation| {
                operation.input["command"].as_str() != Some("deviceSettingsChanged")
                    || operation.input["vault_id"].as_str() != Some(vault_id.as_str())
            });
        }
        if self.operations.len() >= 1024 {
            return Err(invalid());
        }
        let mut action = None;
        match command {
            HostCommand::PickerOpen { vault_id } => {
                if !crate::profiles::valid_id(&vault_id) {
                    return Err(invalid());
                }
                if self.exported {
                    action = Some(Action::Open(vault_id));
                } else if !self.bootstrap_started {
                    self.bootstrap_started = true;
                    action = Some(Action::Initialize { vault_id });
                } else {
                    return Err(invalid());
                }
            }
            HostCommand::Quit => {
                if !self.exported {
                    return Err(invalid());
                }
                self.quitting = Some(request.id);
                action = Some(Action::Quit);
            }
            HostCommand::OpenStatus { .. }
            | HostCommand::WindowState { .. }
            | HostCommand::ShortcutRegistrationStatus
            | HostCommand::AutostartStatus { .. }
            | HostCommand::UpdateCheckStatus { .. } => {
                unreachable!()
            }
            HostCommand::UpdateCheck {
                vault_id,
                launch_id,
                force,
            } => {
                let launch = self.workers.get(&vault_id).ok_or_else(invalid)?;
                if !self.exported
                    || launch.id != launch_id
                    || !launch.ready
                    || launch.endpoint.is_none()
                    || launch.error.is_some()
                {
                    return Err(invalid());
                }
                action = Some(Action::UpdateCheck(force));
            }
            HostCommand::UpdateInstall {
                vault_id,
                launch_id,
                update_id,
            } => {
                let launch = self.workers.get(&vault_id).ok_or_else(invalid)?;
                if !self.exported
                    || launch.id != launch_id
                    || !launch.ready
                    || launch.endpoint.is_none()
                    || launch.error.is_some()
                {
                    return Err(invalid());
                }
                if self.recovering {
                    return Err(AppError::InvalidArg(
                        "update restart recovery must finish before installing another update"
                            .into(),
                    ));
                }
                self.quitting = Some(request.id);
                action = Some(Action::UpdateInstall(update_id));
            }
            HostCommand::Autostart {
                vault_id,
                launch_id,
                enabled,
            } => {
                let launch = self.workers.get(&vault_id).ok_or_else(invalid)?;
                if !self.exported
                    || launch.id != launch_id
                    || !launch.ready
                    || launch.endpoint.is_none()
                    || launch.error.is_some()
                {
                    return Err(invalid());
                }
                action = Some(Action::Autostart(enabled));
            }
            HostCommand::Tray { action: tray } => {
                if !self.exported {
                    return Err(invalid());
                }
                action = Some(Action::Tray(tray));
            }
            HostCommand::InviteLink { link } => {
                if !crate::deep_links::is_invite_link(&link) {
                    return Err(invalid());
                }
                if self.recovering || !self.exported {
                    // Startup delivers it once a vault can be opened. Showing
                    // the picker is left to startup, which knows if it must.
                    self.pending_invite_link = Some(link);
                } else {
                    action = Some(Action::InviteLink(link));
                }
            }
            HostCommand::Shortcut {
                command_id,
                accelerator,
            } => {
                if !self.exported {
                    return Err(invalid());
                }
                action = Some(Action::Shortcut(command_id, accelerator));
            }
            HostCommand::Status => {
                return Ok((
                    json!({"contract":RuntimeContract::current(),"initialized":self.exported,"recovering":self.recovering,"recoveryRetry":self.update_retry,"active":self.last,"quitting":self.quitting,"handoff":self.handoff,"workers":self.workers.iter().map(|(id, launch)| json!({
                    "id":id,"ready":launch.ready,"window":launch.focused_window,"error":launch.error,
                })).collect::<Vec<_>>()}),
                    None,
                ));
            }
            HostCommand::Focused {
                vault_id,
                launch_id,
                window,
            } => {
                if !valid_window(&window) {
                    return Err(invalid());
                }
                let launch = self.workers.get_mut(&vault_id).ok_or_else(invalid)?;
                if launch.id != launch_id
                    || !launch.ready
                    || launch.endpoint.is_none()
                    || launch.error.is_some()
                {
                    return Err(invalid());
                }
                let revision = self.focus_revision.checked_add(1).ok_or_else(invalid)?;
                launch.focused_window = Some(window);
                self.focus_revision = revision;
                self.focus_order.retain(|id| id != &vault_id);
                self.focus_order.push(vault_id.clone());
                self.shortcut_order.retain(|id| id != &vault_id);
                self.shortcut_order.push(vault_id.clone());
                if self.shortcut_order.len() > 4096 {
                    self.shortcut_order.remove(0);
                }
                self.last = Some(vault_id.clone());
                action = Some(Action::Remember { vault_id, revision });
            }
            HostCommand::Activate => {
                if self.recovering || !self.exported {
                    self.activate_after_startup = true;
                    if !self.bootstrap_started && !self.exported {
                        action = Some(Action::ShowPicker);
                    }
                } else if std::mem::take(&mut self.update_retry) {
                    // Launching the app again is the one retry of a session
                    // that failed to reopen. Opens wait for its outcome.
                    self.recovering = true;
                    action = Some(Action::RetryRecovery);
                } else if self.exported {
                    action = Some(
                        self.last
                            .clone()
                            .map(Action::Open)
                            .unwrap_or(Action::ActivateLast),
                    );
                }
            }
            HostCommand::Open { vault_id } => {
                if !self.exported || !crate::profiles::valid_id(&vault_id) {
                    return Err(invalid());
                }
                action = Some(Action::Open(vault_id));
            }
            HostCommand::OpenFromWindow {
                source_vault_id,
                launch_id,
                vault_id,
            } => {
                // Observations are only menu hints. Revalidate the source and
                // let open() recheck the indexed target and its physical lease.
                self.window_state(&source_vault_id, launch_id)?;
                if !crate::profiles::valid_id(&vault_id) {
                    return Err(invalid());
                }
                action = Some(Action::Open(vault_id));
            }
            HostCommand::HandoffFromWindow {
                source_vault_id,
                launch_id,
                vault_id,
            } => {
                self.window_state(&source_vault_id, launch_id)?;
                if self.recovering || !crate::profiles::valid_id(&vault_id) {
                    return Err(invalid());
                }
                self.handoff = Some(request.id);
                action = Some(Action::Handoff {
                    source: source_vault_id,
                    launch_id,
                    target: vault_id,
                });
            }
            HostCommand::DeviceSettingsChanged {
                vault_id,
                launch_id,
            } => {
                let launch = self.workers.get(&vault_id).ok_or_else(invalid)?;
                if launch.id != launch_id || launch.endpoint.is_none() || launch.error.is_some() {
                    return Err(invalid());
                }
                action = Some(Action::RefreshDeviceSettings);
            }
            HostCommand::Authorize {
                vault_id,
                launch_id,
                coordinator_id,
                contract,
            } => {
                if &contract != RuntimeContract::current()
                    || coordinator_id != instance
                    || !self.exported
                    || !self.workers.get(&vault_id).is_some_and(|launch| {
                        launch.id == launch_id && !launch.ready && launch.error.is_none()
                    })
                {
                    return Err(invalid());
                }
            }
            HostCommand::Register {
                vault_id,
                launch_id,
                endpoint,
                contract,
            } => {
                if &contract != RuntimeContract::current() {
                    return Err(invalid());
                }
                let launch = self.workers.get_mut(&vault_id).ok_or_else(invalid)?;
                if launch.id != launch_id || launch.ready || launch.error.is_some() {
                    return Err(invalid());
                }
                if launch
                    .endpoint
                    .as_ref()
                    .is_some_and(|old| old.instance() != endpoint.instance())
                {
                    return Err(invalid());
                }
                launch.endpoint = Some(endpoint);
            }
            HostCommand::AuthorizeAdoption {
                vault_id,
                launch_id,
                coordinator_id,
                contract,
            } => {
                if &contract != RuntimeContract::current()
                    || coordinator_id != instance
                    || !self.workers.get(&vault_id).is_some_and(|launch| {
                        launch.id == launch_id
                            && launch.endpoint.is_some()
                            && launch.error.is_none()
                    })
                {
                    return Err(invalid());
                }
            }
            HostCommand::StartupFailed {
                vault_id,
                launch_id,
                message,
            } => {
                // Only a worker that never became ready may fail its launch.
                // It exits next; its released lease then permits a retry.
                let launch = self.workers.get_mut(&vault_id).ok_or_else(invalid)?;
                if launch.id != launch_id
                    || launch.ready
                    || message.is_empty()
                    || message.len() > STARTUP_FAILURE_MAX
                {
                    return Err(invalid());
                }
                launch.error.get_or_insert(message);
            }
            HostCommand::Ready {
                vault_id,
                launch_id,
            } => {
                let launch = self.workers.get_mut(&vault_id).ok_or_else(invalid)?;
                if launch.id != launch_id || launch.endpoint.is_none() || launch.error.is_some() {
                    return Err(invalid());
                }
                if !launch.ready {
                    launch.ready = true;
                    self.had_ready_worker = true;
                    // Tracked requests perform their own authenticated activation
                    // before publishing success. Startup still activates here.
                    if launch.activate_on_ready
                        && self.quitting.is_none()
                        && self.handoff.is_none()
                        && !self.operations.values().any(|operation| {
                            matches!(
                                operation.input["command"].as_str(),
                                Some(
                                    "open" | "openFromWindow" | "handoffFromWindow" | "pickerOpen"
                                )
                            ) && operation.input["vault_id"].as_str() == Some(vault_id.as_str())
                                && operation.open_result.is_none()
                        })
                    {
                        action = Some(Action::Open(vault_id));
                    }
                }
            }
        }
        let reply = if self.quitting == Some(request.id) {
            json!({"accepted":true,"operation_id":request.id})
        } else {
            json!({"accepted":true})
        };
        self.operations.insert(
            request.id,
            Operation {
                input: request.payload,
                reply: reply.clone(),
                at: Instant::now(),
                open_result: None,
                autostart_result: None,
                update_result: None,
            },
        );
        Ok((reply, action))
    }
}
pub struct Host {
    instance: Uuid,
    endpoint: Endpoint,
    book: Mutex<Book>,
    jobs: crate::vault_jobs::Jobs,
    device_notifications: crate::device_notifications::Notifications,
    _server: Running,
}
pub struct Worker {
    vault_id: String,
    launch_id: Uuid,
    host: Arc<Mutex<Endpoint>>,
    ready: Arc<AtomicBool>,
    last_window: Arc<Mutex<Option<String>>>,
    _server: Running,
}

pub(crate) fn ready_for_close(app: &AppHandle) -> bool {
    app.try_state::<Worker>()
        .is_some_and(|worker| worker.ready.load(Ordering::Acquire))
}

fn invalid() -> AppError {
    AppError::InvalidArg("vault coordinator request could not be completed".into())
}

fn valid_window(label: &str) -> bool {
    label == "main" || (label.starts_with("note_") && label.len() > 5 && label.len() <= 256)
}

pub fn window_focused(app: &AppHandle, label: &str) {
    if !valid_window(label) {
        return;
    }
    let Some(worker) = app.try_state::<Worker>() else {
        return;
    };
    if !worker.ready.load(Ordering::Acquire) {
        return;
    }
    if let Ok(mut last_window) = worker.last_window.lock() {
        *last_window = Some(label.into());
    }
    let Ok(host) = worker.host.lock().map(|host| host.clone()) else {
        return;
    };
    let Ok(request) = request(&HostCommand::Focused {
        vault_id: worker.vault_id.clone(),
        launch_id: worker.launch_id,
        window: label.into(),
    }) else {
        return;
    };
    let _ = std::thread::Builder::new()
        .name("vault-focus".into())
        .spawn(move || {
            if !matches!(host.retry_call(&request), Ok(Ok(_))) {
                log::warn!("[vaults] focus notification unavailable");
            }
        });
}

pub fn activate(app: &AppHandle) {
    if app.try_state::<Host>().is_some() {
        if let Ok(request) = request(&HostCommand::Activate) {
            let _ = handle_host(app, request);
        }
    } else if let Some(worker) = app.try_state::<Worker>() {
        let Ok(host) = worker.host.lock().map(|host| host.clone()) else {
            return;
        };
        if let Ok(request) = request(&HostCommand::Activate) {
            let _ = std::thread::Builder::new()
                .name("vault-activate".into())
                .spawn(move || {
                    let _ = host.retry_call(&request);
                });
        }
    } else {
        crate::tray::focus_main_window(app);
    }
}

fn request(command: &impl Serialize) -> AppResult<Request> {
    Ok(Request {
        id: Uuid::new_v4(),
        payload: serde_json::to_value(command).map_err(|_| invalid())?,
    })
}

/// Send invalidation only. Each worker reloads the root and its own vault;
/// content/account values never travel between vault processes.
pub fn device_settings_changed(app: &AppHandle) {
    let Some(worker) = app.try_state::<Worker>() else {
        return;
    };
    let Ok(host) = worker.host.lock().map(|host| host.clone()) else {
        return;
    };
    let Ok(request) = request(&HostCommand::DeviceSettingsChanged {
        vault_id: worker.vault_id.clone(),
        launch_id: worker.launch_id,
    }) else {
        return;
    };
    if std::thread::Builder::new()
        .name("device-settings-notify".into())
        .spawn(move || {
            if !matches!(host.retry_call(&request), Ok(Ok(_))) {
                log::warn!(
                    "[vaults] device settings notification unavailable; values remain persisted"
                );
            }
        })
        .is_err()
    {
        log::warn!("[vaults] device settings notification thread unavailable");
    }
}

fn broadcast_device_settings(app: &AppHandle) {
    let Some(host) = app.try_state::<Host>() else {
        return;
    };
    let _ = app.emit(crate::app_events::AppEvent::UiSettingsChanged.as_str(), ());
    // Targets are copied under the short book mutex. Delivery never holds it
    // or a root document lock while contacting another worker.
    host.device_notifications.changed(|| {
        host.book
            .lock()
            .map(|book| book.device_targets())
            .unwrap_or_else(|_| {
                log::warn!("[vaults] worker settings targets unavailable");
                Vec::new()
            })
    });
}

fn adopt_host(
    registration: &crate::worker_registration::Registration,
    current: &Mutex<Endpoint>,
    launch_id: Uuid,
    candidate: Endpoint,
) -> AppResult<()> {
    if launch_id != registration.launch_id || candidate != Endpoint::read(&registration.root)? {
        return Err(invalid());
    }
    candidate
        .retry_call(&request(&HostCommand::AuthorizeAdoption {
            vault_id: registration.vault_id.clone(),
            launch_id,
            coordinator_id: candidate.instance(),
            contract: RuntimeContract::current().clone(),
        })?)?
        .map_err(AppError::InvalidArg)?;
    *current.lock().map_err(|_| invalid())? = candidate;
    Ok(())
}

/// Ordinary desktop launches use the coordinator; isolated e2e devices retain
/// direct mode unless they explicitly request a shared-root supervisor.
pub fn startup_role(kind: crate::environment::Kind) -> AppResult<Role> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    Role::parse(kind, &args)
}

pub fn start_host(app: &tauri::App) -> AppResult<()> {
    // Direct harness devices may override their vault directory. A supervisor
    // must resolve every worker through one root index instead.
    if crate::profiles::dir_override().is_some() {
        return Err(AppError::InvalidArg(
            "supervised startup requires a root override without a vault-directory override".into(),
        ));
    }
    let root = crate::paths::app_data_root(app)?;
    let coordinator = match ipc::elect(&root)? {
        ipc::Election::Existing => {
            let quiet = crate::was_started_by_autostart()
                || crate::coordinator_revival::background_launch();
            let (endpoint, reply) = match ipc::request_with_endpoint(
                &root,
                &request(&HostCommand::Status)?,
            ) {
                Ok(reply) => reply,
                // The lease is held but nothing answers. Ownership is never
                // taken over; the user decides what happens to that process.
                Err(error) if !quiet => {
                    log::error!("[vaults] running coordinator is unresponsive: {error}");
                    use tauri_plugin_dialog::DialogExt;
                    let handle = app.handle().clone();
                    app.dialog()
                            .message("Mindstream Notes is already running but is not responding. End the running Mindstream Notes process, then start it again.")
                            .title("Mindstream Notes")
                            .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                            .show(move |_| handle.exit(1));
                    return Ok(());
                }
                Err(error) => return Err(error),
            };
            reply.map_err(AppError::InvalidArg)?;
            if !quiet {
                crate::foreground::transfer(&endpoint);
                // Started for an invite link: the running app shows it.
                let forwarded = match crate::deep_links::invite_link_among(std::env::args().skip(1))
                {
                    Some(link) => match request(&HostCommand::InviteLink { link })
                        .and_then(|request| endpoint.retry_call(&request))
                        .and_then(|reply| reply.map_err(AppError::InvalidArg))
                    {
                        Ok(_) => true,
                        Err(error) => {
                            // An older build, or one that is quitting. The
                            // window still comes to the front below.
                            log::warn!("[deep-link] running app did not take the link: {error}");
                            false
                        }
                    },
                    None => false,
                };
                if !forwarded {
                    endpoint
                        .retry_call(&request(&HostCommand::Activate)?)?
                        .map_err(AppError::InvalidArg)?;
                }
            }
            app.handle().exit(0);
            return Ok(());
        }
        ipc::Election::Owner(coordinator) => coordinator,
    };
    crate::worker_registration::preflight(&root)?;
    let index = crate::profiles::prepare_coordinator_index(&root)?;
    if let Err(error) = crate::shortcut_routing::prepare(&root) {
        // Optional shortcut history must not prevent manual vault access. Its
        // corrupt evidence stays intact and shortcut selection fails closed.
        log::warn!("[vaults] shortcut history unavailable: {error}");
    }
    let instance = coordinator.endpoint().instance();
    let endpoint = coordinator.endpoint().clone();
    let handle = app.handle().clone();
    let server = coordinator.serve(move |request| {
        handle_host(&handle, request)
            .map_err(|_| "vault request unavailable; ownership retained".into())
    })?;
    app.manage(crate::coordinator_shortcuts::Shortcuts::default());
    app.manage(crate::coordinator_updater::Updates::default());
    app.manage(Host {
        instance,
        endpoint,
        book: Mutex::new(Book {
            recovering: true,
            ..Book::default()
        }),
        jobs: crate::vault_jobs::Jobs::default(),
        device_notifications: crate::device_notifications::Notifications::default(),
        _server: server,
    });
    if let Some(settings) = crate::desktop_settings::DesktopSettings::load_existing_root(&root)
        .map_err(|error| AppError::InvalidArg(error.to_string()))?
    {
        app.manage(settings);
    }
    #[cfg(target_os = "macos")]
    crate::native_menu::init(app)?;
    // Workers never create a tray. As with direct test devices, isolated roots
    // may have their own icon, while system shortcuts/updaters remain gated.
    crate::tray::init(app)?;
    start_lifetime_monitor(app.handle())?;
    // Kept until startup has a vault to show it in.
    crate::deep_links::listen_for_vaults(app.handle());
    let initial = if crate::profiles::profile_dir(&root, &index.active).is_dir() {
        index.active.clone()
    } else if let Some(id) = surviving_startup_vault(&root, &index)? {
        id
    } else {
        return show_picker(app.handle());
    };
    app.state::<Host>()
        .book
        .lock()
        .map_err(|_| invalid())?
        .bootstrap_started = true;
    begin_host_startup(app.handle(), initial, None)
}

fn surviving_startup_vault(
    root: &std::path::Path,
    index: &crate::profiles::Index,
) -> AppResult<Option<String>> {
    let mut candidates = crate::shortcut_routing::startup_order(root).unwrap_or_default();
    for profile in &index.profiles {
        if !candidates.contains(&profile.id) {
            candidates.push(profile.id.clone());
        }
    }
    for id in candidates {
        if !index.profiles.iter().any(|profile| profile.id == id) {
            continue;
        }
        let directory = crate::profiles::profile_dir(root, &id);
        if !directory.is_dir() || !crate::storage_locks::VaultLock::is_owned(&directory)? {
            continue;
        }
        if let crate::worker_registration::Recovery::Held(record) =
            crate::worker_registration::reconcile(root, &id, &directory)?
        {
            let identity = record.identify()?;
            identity.require_compatible()?;
            if identity.ready {
                return Ok(Some(id));
            }
        }
    }
    Ok(None)
}

fn begin_host_startup(
    app: &AppHandle,
    initial: String,
    operation_id: Option<Uuid>,
) -> AppResult<()> {
    let root = crate::paths::app_data_root(app)?;
    // Seed/recover device settings before a second worker can win the first
    // migration race. The startup-selected vault is the sole legacy source.
    app.manage(
        crate::desktop_settings::DesktopSettings::load_for_coordinator(&root, &initial)
            .map_err(|error| AppError::InvalidArg(error.to_string()))?,
    );
    crate::desktop_settings::refresh_runtime(app)
        .map_err(|error| AppError::InvalidArg(error.to_string()))?;
    let vault = crate::profiles::profile_dir(&root, &initial);
    crate::plugins::packages::prepare(&root, &vault)?;
    crate::plugins::settings::prepare(&root, &vault)?;
    crate::ui_settings::prepare_device_appearance(&root, &vault, &initial)?;
    crate::legacy_content::initialize_owner(&root, &initial, &vault)?;

    let background_recovery = crate::coordinator_revival::background_launch();
    let activate_initial = !background_recovery
        && (!crate::was_started_by_autostart()
            || !crate::desktop_settings::should_start_in_tray(app));
    crate::legacy_export::begin(
        app,
        initial.clone(),
        Box::new(move |app| {
            let task_app = app.clone();
            let job = match app.state::<Host>().jobs.enter() {
                Ok(job) => job,
                Err(error) => {
                    startup_failed(&app, operation_id, error);
                    return;
                }
            };
            if let Err(error) = std::thread::Builder::new()
                .name("vault-recovery".into())
                .spawn(move || {
                    let _job = job;
                    if let Err(error) = recover_workers(&task_app) {
                        log::error!("[vaults] worker discovery failed: {error}");
                        startup_failed(&task_app, operation_id, error);
                        return;
                    }
                    let mut target = initial;
                    if let Some(host) = task_app.try_state::<Host>() {
                        if let Ok(mut book) = host.book.lock() {
                            book.exported = true;
                            book.had_ready_worker |= background_recovery
                                || book.workers.values().any(|launch| launch.ready);
                            if book.last.is_none() {
                                let recovered = book
                                    .workers
                                    .get(&target)
                                    .filter(|launch| launch.ready && launch.error.is_none())
                                    .map(|_| target.clone())
                                    .or_else(|| {
                                        book.workers
                                            .iter()
                                            .find(|(_, launch)| {
                                                launch.ready && launch.error.is_none()
                                            })
                                            .map(|(id, _)| id.clone())
                                    });
                                if let Some(id) = recovered {
                                    book.focus_order.push(id.clone());
                                    book.last = Some(id);
                                }
                            }
                            if let Some(id) = &book.last {
                                target = id.clone();
                            }
                        }
                    }
                    quarantine_unresumable_records(&task_app);
                    let mut startup_result = Ok(());
                    let mut open_initial = !background_recovery;
                    let recovery_finished = match resume_handoff(&task_app) {
                        Ok(true) => {
                            open_initial = false;
                            true
                        }
                        Ok(false) => {
                            match resume_update(&task_app, Instant::now() + RECOVERY_LIMIT) {
                                Ok(resumed) => open_initial &= !resumed,
                                // Vaults stay reachable: startup continues normally.
                                Err(error) => report_recovery_failure(&task_app, &error),
                            }
                            true
                        }
                        Err(error) => {
                            log::error!("[vaults] handoff recovery failed: {error}");
                            // The lifetime monitor retries a pinned intent a bounded
                            // number of times. Without one nothing would ever unblock.
                            let pinned = task_app
                                .state::<Host>()
                                .book
                                .lock()
                                .is_ok_and(|book| book.handoff.is_some());
                            if !pinned {
                                report_recovery_failure(&task_app, &error);
                            }
                            startup_result = Err(AppError::InvalidArg(error.to_string()));
                            !pinned
                        }
                    };
                    if recovery_finished && open_initial {
                        if let Err(error) =
                            open_and_wait_with_activation(&task_app, &target, activate_initial)
                        {
                            log::error!("[vaults] initial launch failed: {error}");
                            startup_result = Err(error);
                            let picker = task_app.clone();
                            let _ = task_app.run_on_main_thread(move || {
                                let _ = show_picker(&picker);
                            });
                        }
                    }
                    if let Some(id) = operation_id {
                        if let Ok(mut book) = task_app.state::<Host>().book.lock() {
                            book.complete_open(id, startup_result);
                        }
                    }
                    if recovery_finished {
                        let activate =
                            task_app
                                .state::<Host>()
                                .book
                                .lock()
                                .ok()
                                .and_then(|mut book| {
                                    book.recovering = false;
                                    if book.quitting.is_none()
                                        && std::mem::take(&mut book.activate_after_startup)
                                    {
                                        book.last.clone()
                                    } else {
                                        None
                                    }
                                });
                        if let Some(id) = activate {
                            if let Err(error) = open_and_wait(&task_app, &id) {
                                log::warn!("[vaults] deferred launch activation failed: {error}");
                            }
                        }
                        deliver_pending_invite_link(&task_app);
                    }
                    broadcast_device_settings(&task_app);
                    crate::coordinator_shortcuts::refresh(&task_app);
                })
            {
                log::error!("[vaults] recovery thread unavailable: {error}");
                startup_failed(&app, operation_id, AppError::InvalidArg(error.to_string()));
            }
        }),
    )?;
    Ok(())
}

/// A journal that can never be resumed must not fail every startup. Its
/// evidence is set aside and normal startup continues without that session.
fn quarantine_unresumable_records(app: &AppHandle) {
    let Ok(root) = crate::paths::app_data_root(app) else {
        return;
    };
    let version = app.package_info().version.to_string();
    for result in [
        crate::vault_handoff::quarantine_unresumable(&root),
        crate::update_recovery::quarantine_unresumable(&root, &version),
    ] {
        match result {
            Ok(None) => {}
            Ok(Some(evidence)) => {
                log::error!(
                    "[vaults] unresumable startup record set aside: {}",
                    evidence.display()
                );
                use tauri_plugin_dialog::DialogExt;
                app.dialog()
                    .message(format!(
                        "A saved window session could not be resumed and was set aside. Your vaults are unchanged.\n\n{}",
                        evidence.display()
                    ))
                    .title("Startup recovery")
                    .show(|_| {});
            }
            // Resumption reports the same failure and retains the record.
            Err(error) => log::warn!("[vaults] startup record check unavailable: {error}"),
        }
    }
}

fn report_recovery_failure(app: &AppHandle, error: &AppError) {
    log::error!("[vaults] startup recovery failed: {error}");
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .message(format!(
            "Startup recovery could not finish. Your vaults are unchanged and can be opened normally.\n\n{error}"
        ))
        .title("Startup recovery")
        .show(|_| {});
}

fn startup_failed(app: &AppHandle, operation_id: Option<Uuid>, error: AppError) {
    log::error!("[vaults] startup failed; picker retry available: {error}");
    let show = app
        .state::<Host>()
        .book
        .lock()
        .map(|mut book| {
            book.startup_failed(operation_id, error);
            book.quitting.is_none()
        })
        .unwrap_or(false);
    if show {
        let picker = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = show_picker(&picker);
        });
    }
}

#[derive(Serialize)]
pub struct PickerVault {
    id: String,
    name: String,
    available: bool,
    color: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerView {
    vaults: Vec<PickerVault>,
    language_code: String,
    theme_mode: crate::desktop_settings::DesktopThemeMode,
}

fn picker_preferences(
    root: &std::path::Path,
) -> AppResult<(String, crate::desktop_settings::DesktopThemeMode)> {
    Ok(
        crate::desktop_settings::DesktopSettings::load_existing_root(root)
            .map_err(|error| AppError::InvalidArg(error.to_string()))?
            .map(|settings| (settings.language_code(), settings.theme_mode()))
            .unwrap_or_else(|| {
                (
                    "en".into(),
                    crate::desktop_settings::DesktopThemeMode::System,
                )
            }),
    )
}

pub(crate) fn allows_host_invoke(label: &str, command: &str) -> bool {
    command == "finish_legacy_browser_export"
        || (label == "vault-picker"
            && matches!(
                command,
                "get_picker_vaults"
                    | "open_picker_vault"
                    | "create_profile"
                    | "get_theme_appearance"
            ))
}

fn picker_caller(app: &AppHandle, window: &WebviewWindow) -> AppResult<()> {
    if app.try_state::<Host>().is_none()
        || window.label() != "vault-picker"
        || !matches!(window.url()?.path(), "/vault-picker" | "/vault-picker/")
    {
        return Err(invalid());
    }
    Ok(())
}

#[tauri::command]
pub fn get_picker_vaults(app: AppHandle, window: WebviewWindow) -> CommandResult<PickerView> {
    picker_caller(&app, &window)?;
    let root = crate::paths::app_data_root(&app)?;
    let (language_code, theme_mode) = picker_preferences(&root)?;
    let vaults = crate::profiles::load_or_init(&root)?
        .profiles
        .into_iter()
        .map(|vault| PickerVault {
            available: crate::profiles::profile_dir(&root, &vault.id).is_dir(),
            id: vault.id,
            name: vault.name,
            color: vault.color,
        })
        .collect();
    Ok(PickerView {
        vaults,
        language_code,
        theme_mode,
    })
}

#[tauri::command]
pub async fn open_picker_vault(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
) -> CommandResult<()> {
    picker_caller(&app, &window)?;
    let root = crate::paths::app_data_root(&app)?;
    let index = crate::profiles::prepare_coordinator_index(&root)?;
    if !index.profiles.iter().any(|vault| vault.id == id)
        || !crate::profiles::profile_dir(&root, &id).is_dir()
    {
        return Err(invalid().into());
    }
    let request = request(&HostCommand::PickerOpen { vault_id: id })?;
    let endpoint = app.state::<Host>().endpoint.clone();
    let handle = app.clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        crate::foreground::transfer(&endpoint);
        endpoint
            .retry_call(&request)?
            .map_err(AppError::InvalidArg)?;
        await_open_result(
            &endpoint,
            request.id,
            Instant::now() + OPEN_TIMEOUT + Duration::from_secs(60),
        )?;
        handle.run_on_main_thread(move || {
            let _ = window.destroy();
        })?;
        Ok::<_, AppError>(())
    })
    .await
    .map_err(|_| invalid())??)
}

fn show_picker(app: &AppHandle) -> AppResult<()> {
    if let Some(window) = app.get_webview_window("vault-picker") {
        app.state::<Host>()
            .book
            .lock()
            .map_err(|_| invalid())?
            .picker_open = true;
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }
    let root = crate::paths::app_data_root(app)?;
    let (language_code, theme_mode) = picker_preferences(&root)?;
    let identity =
        crate::browser_identity::Identity::for_vault(&root, "coordinator-picker", &root)?;
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        "vault-picker",
        tauri::WebviewUrl::App("vault-picker/".into()),
    )
    .initialization_script(crate::theme_presets::initialization_script(app)?)
    .title(
        if app.state::<crate::environment::Environment>().kind == crate::environment::Kind::Dev {
            format!(
                "Mindstream Notes Dev: {}",
                crate::i18n::t_ui(&language_code, "vault.picker.title")
            )
        } else {
            format!(
                "Mindstream Notes: {}",
                crate::i18n::t_ui(&language_code, "vault.picker.title")
            )
        },
    )
    .inner_size(560.0, 540.0)
    .min_inner_size(420.0, 360.0)
    .visible(true)
    .focused(true)
    .initialization_script(format!(
        "try {{ localStorage.setItem('mode-watcher-mode', {}); }} catch (_) {{}}",
        serde_json::to_string(&theme_mode).map_err(|_| invalid())?
    ));
    if let Some(args) = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .and_then(|window| window.additional_browser_args.as_ref())
    {
        builder = builder.additional_browser_args(args);
    }
    let window = identity.apply(builder).build()?;
    app.state::<Host>()
        .book
        .lock()
        .map_err(|_| invalid())?
        .picker_open = true;
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. })
            && handle
                .state::<Host>()
                .book
                .lock()
                .is_ok_and(|book| !book.exported && book.workers.is_empty())
        {
            handle.exit(0);
        }
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Ok(mut book) = handle.state::<Host>().book.lock() {
                book.picker_open = false;
            }
        }
    });
    Ok(())
}

fn recover_workers(app: &AppHandle) -> AppResult<()> {
    let root = crate::paths::app_data_root(app)?;
    let index = crate::profiles::prepare_coordinator_index(&root)?;
    for vault in index.profiles {
        if !crate::profiles::profile_dir(&root, &vault.id).is_dir() {
            // A missing path cannot be launched or recreated by supervision.
            // Retain its index/discovery evidence, but do not invent a live
            // nil-UUID worker that would make every later Quit fail.
            continue;
        }
        if let Err(error) = recover_worker(app, &root, &vault.id) {
            let host = app.state::<Host>();
            host.book.lock().map_err(|_| invalid())?.workers.insert(
                vault.id,
                Launch {
                    id: Uuid::nil(),
                    endpoint: None,
                    ready: false,
                    activate_on_ready: false,
                    error: Some("vault owner could not be identified; ownership retained".into()),
                    adopted: true,
                    focused_window: None,
                },
            );
            log::warn!("[vaults] worker discovery refused: {error}");
        }
    }
    Ok(())
}

fn recover_worker(app: &AppHandle, root: &std::path::Path, id: &str) -> AppResult<()> {
    use crate::worker_registration::{Identity, Recovery};
    let directory = crate::profiles::profile_dir(root, id);
    let Recovery::Held(record) = crate::worker_registration::reconcile(root, id, &directory)?
    else {
        return Ok(());
    };
    // Endpoint correlation/authentication and the canonical physical identity
    // are both required. Never infer ownership from a PID or an open socket.
    record.identify()?.require_compatible()?;
    let host = app.state::<Host>();
    {
        let mut book = host.book.lock().map_err(|_| invalid())?;
        if book.workers.contains_key(id) {
            return Err(invalid());
        }
        book.workers.insert(
            id.into(),
            Launch {
                id: record.launch_id,
                endpoint: Some(record.endpoint.clone()),
                ready: false,
                activate_on_ready: false,
                error: None,
                adopted: true,
                focused_window: None,
            },
        );
    }
    let reply = record
        .endpoint
        .retry_call(&Request {
            id: Uuid::new_v4(),
            payload: serde_json::to_value(WorkerCommand::Adopt {
                launch_id: record.launch_id,
                host: host.endpoint.clone(),
                contract: crate::worker_registration::RuntimeContract::current().clone(),
            })
            .map_err(|_| invalid())?,
        })?
        .map_err(AppError::InvalidArg)?;
    let identity: Identity = serde_json::from_value(reply).map_err(|_| invalid())?;
    if !record.matches(&identity) {
        return Err(invalid());
    }
    identity.require_compatible()?;
    if identity
        .window
        .as_ref()
        .is_some_and(|label| !valid_window(label))
    {
        return Err(invalid());
    }
    let mut book = host.book.lock().map_err(|_| invalid())?;
    let launch = book.workers.get_mut(id).ok_or_else(invalid)?;
    if launch.id != record.launch_id {
        return Err(invalid());
    }
    launch.ready |= identity.ready;
    // A focus notification may have raced the adoption reply. Preserve its
    // newer window selection when present.
    if launch.focused_window.is_none() {
        launch.focused_window = identity.window;
    }
    Ok(())
}

/// Also observes adopted workers, which have no child-wait handle in this
/// coordinator. Only a released physical OS lease removes an adopted owner.
fn start_lifetime_monitor(app: &AppHandle) -> AppResult<()> {
    let app = app.clone();
    std::thread::Builder::new()
        .name("vault-lifetime".into())
        .spawn(move || {
            let mut last_error = None;
            loop {
                std::thread::sleep(Duration::from_secs(1));
                let result = reconcile_lifetime(&app);
                let error = result.err().map(|error| error.to_string());
                if error != last_error {
                    if let Some(error) = &error {
                        log::warn!("[vaults] idle exit unavailable; coordinator retained: {error}");
                    }
                    last_error = error;
                }
            }
        })?;
    Ok(())
}

fn reconcile_lifetime(app: &AppHandle) -> AppResult<()> {
    let host = app.state::<Host>();
    let root = crate::paths::app_data_root(app)?;
    reconcile_adopted(&host.book, &root)?;
    let handoff_due = {
        let book = host.book.lock().map_err(|_| invalid())?;
        book.handoff.is_some() && book.handoff_retry_at.is_none_or(|at| Instant::now() >= at)
    };
    if handoff_due && host.jobs.is_idle() {
        let _job = host.jobs.enter()?;
        match resume_handoff(app) {
            Ok(resumed) => {
                let mut book = host.book.lock().map_err(|_| invalid())?;
                book.recovering = false;
                book.handoff_settled();
                if !resumed {
                    // No active intent remains to pin the fence.
                    book.handoff = None;
                    drop(book);
                    crate::coordinator_shortcuts::suspend(app, false);
                }
            }
            Err(error) => {
                let give_up = host
                    .book
                    .lock()
                    .map_err(|_| invalid())?
                    .handoff_failed(Instant::now());
                if !give_up {
                    return Err(error);
                }
                abandon_handoff(app, &root, &error)?;
            }
        }
    }
    if !host
        .book
        .lock()
        .map_err(|_| invalid())?
        .idle_exit_candidate(&host.jobs)
    {
        return Ok(());
    }
    let quit = {
        // Root -> Book is the established lock order. No Book lock crosses a
        // filesystem read, and no root lock crosses shutdown IPC or draining.
        let _root_lock = crate::storage_locks::RootLock::acquire(&root)?;
        // Close-to-tray alone decides, in development as in a release. A vault
        // that enables global shortcuts does not keep a closed app in the tray.
        if crate::desktop_settings::coordinator_keep_alive_locked(&root)? {
            return Ok(());
        }
        let mut book = host.book.lock().map_err(|_| invalid())?;
        // Accepted Open/Activate/capture tasks register their job before
        // releasing Book. They win this race even before reserving a worker.
        if !book.idle_exit_candidate(&host.jobs) {
            return Ok(());
        }
        let quit = request(&HostCommand::Quit)?;
        book.accept(host.instance, quit.clone())?;
        quit.id
    };
    log::info!("[vaults] last vault closed with close-to-tray off; exiting");
    finish_quit(app, quit);
    Ok(())
}

/// A handoff that keeps failing must not fence opens and Quit forever. Its
/// journal is set aside and the vault the user was heading for is opened.
fn abandon_handoff(app: &AppHandle, root: &std::path::Path, error: &AppError) -> AppResult<()> {
    let record = crate::vault_handoff::load(root)
        .ok()
        .flatten()
        .filter(|record| record.active());
    let evidence = crate::vault_handoff::abandon(root)?;
    {
        let host = app.state::<Host>();
        let mut book = host.book.lock().map_err(|_| invalid())?;
        book.handoff = None;
        book.recovering = false;
        book.handoff_settled();
    }
    crate::coordinator_shortcuts::suspend(app, false);
    report_recovery_failure(
        app,
        &AppError::InvalidArg(match evidence {
            Some(evidence) => format!(
                "{error}; switching vaults was abandoned and its record set aside: {}",
                evidence.display()
            ),
            None => format!("{error}; switching vaults was abandoned"),
        }),
    );
    let Some(record) = record else {
        return Ok(());
    };
    // After the source closed, the target is the only vault left to show.
    let vault = if record.phase == crate::vault_handoff::Phase::Closed {
        &record.target.id
    } else {
        &record.source.id
    };
    if let Err(error) = open_and_wait(app, vault) {
        log::error!("[vaults] opening after an abandoned handoff failed: {error}");
        let picker = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = show_picker(&picker);
        });
    }
    Ok(())
}

fn handle_host(app: &AppHandle, request: Request) -> AppResult<Value> {
    let Some(host) = app.try_state::<Host>() else {
        // The authenticated listener may receive a launch in the small interval
        // before managed state is installed. Initial startup already schedules
        // the last-used vault; no worker mutation is permitted here.
        return match serde_json::from_value::<HostCommand>(request.payload)
            .map_err(|_| invalid())?
        {
            HostCommand::Status => Ok(
                json!({"contract":RuntimeContract::current(),"initialized":false,"active":null,"workers":[]}),
            ),
            HostCommand::Activate => Ok(json!({"accepted":true})),
            _ => Err(invalid()),
        };
    };
    let command: HostCommand =
        serde_json::from_value(request.payload.clone()).map_err(|_| invalid())?;
    if matches!(command, HostCommand::ShortcutRegistrationStatus) {
        return serde_json::to_value(host_shortcut_status(app)?).map_err(|_| invalid());
    }
    let settings_notice = matches!(command, HostCommand::Ready { .. });
    let window_observation = matches!(command, HostCommand::WindowState { .. });
    let tracked_open = matches!(
        command,
        HostCommand::Open { .. }
            | HostCommand::OpenFromWindow { .. }
            | HostCommand::HandoffFromWindow { .. }
            | HostCommand::PickerOpen { .. }
            | HostCommand::Shortcut { .. }
            | HostCommand::Tray { .. }
            | HostCommand::InviteLink { .. }
    );
    let status_request = matches!(command, HostCommand::Status);
    if matches!(
        command,
        HostCommand::Status
            | HostCommand::WindowState { .. }
            | HostCommand::Activate
            | HostCommand::Open { .. }
            | HostCommand::OpenFromWindow { .. }
            | HostCommand::HandoffFromWindow { .. }
            | HostCommand::PickerOpen { .. }
            | HostCommand::Shortcut { .. }
            | HostCommand::Tray { .. }
            | HostCommand::InviteLink { .. }
    ) {
        reconcile_adopted(&host.book, &crate::paths::app_data_root(app)?)?;
    }
    // Replies are acknowledgements. Root filesystem work and worker IPC run
    // after this short critical section, never under the root document lock.
    let request_id = request.id;
    let (mut reply, action, job, refresh_job) = {
        let mut book = host.book.lock().map_err(|_| invalid())?;
        let (reply, action) = book.accept(host.instance, request)?;
        // Register work while acceptance still holds Book. Quit cannot finish
        // draining before a previously accepted filesystem task starts.
        let job = if action
            .as_ref()
            .is_some_and(|a| !matches!(a, Action::Quit | Action::UpdateInstall(_)))
        {
            Some(host.jobs.enter()?)
        } else {
            None
        };
        let refresh_job = if settings_notice {
            Some(host.jobs.enter()?)
        } else {
            None
        };
        (reply, action, job, refresh_job)
    };
    if window_observation {
        let root = crate::paths::app_data_root(app)?;
        let mut view: crate::vault_window_state::View =
            serde_json::from_value(reply).map_err(|_| invalid())?;
        for vault in crate::profiles::load_or_init(&root)?.profiles {
            if !crate::profiles::profile_dir(&root, &vault.id).is_dir()
                && !view.vaults.iter().any(|entry| entry.vault_id == vault.id)
            {
                view.vaults.push(crate::vault_window_state::Entry {
                    vault_id: vault.id,
                    status: crate::vault_window_state::Status::Unavailable,
                });
            }
        }
        reply = serde_json::to_value(view).map_err(|_| invalid())?;
    }
    if status_request {
        // Disk reads happen after releasing Book. No general root lock crosses
        // worker IPC, and a bad settings file never hides ownership status.
        let recent = host
            .book
            .lock()
            .map_err(|_| invalid())?
            .shortcut_order
            .clone();
        reply["shortcuts"] = crate::paths::app_data_root(app)
            .and_then(|root| crate::shortcut_routing::select(&root, &recent))
            .and_then(|selection| serde_json::to_value(selection).map_err(|_| invalid()))
            .unwrap_or_else(|_| json!({"state":"unavailable"}));
        reply["shortcutRegistration"] =
            serde_json::to_value(host_shortcut_status(app)?).map_err(|_| invalid())?;
    }
    if let Some(action) = action {
        let task_app = app.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("vault-open".into())
            .spawn(move || {
                let _job = job;
                let target = match action {
                    Action::UpdateCheck(force) => {
                        let result = crate::coordinator_updater::check(&task_app, force);
                        let progress = match result {
                            Ok(available) => {
                                crate::coordinator_updater::CheckProgress::Ready { available }
                            }
                            Err(error) => crate::coordinator_updater::CheckProgress::Failed {
                                message: error.to_string(),
                            },
                        };
                        if let Ok(mut book) = task_app.state::<Host>().book.lock() {
                            if let Some(operation) = book.operations.get_mut(&request_id) {
                                operation.update_result = Some(progress);
                            }
                        }
                        return;
                    }
                    Action::UpdateInstall(id) => {
                        crate::coordinator_shortcuts::suspend(&task_app, true);
                        crate::coordinator_updater::install(&task_app, request_id, id);
                        return;
                    }
                    Action::Autostart(enabled) => {
                        let result = crate::coordinator_autostart::read_or_set(&task_app, enabled);
                        if let Ok(mut book) = task_app.state::<Host>().book.lock() {
                            book.complete_autostart(request_id, result);
                        }
                        return;
                    }
                    Action::Quit => {
                        finish_quit(&task_app, request_id);
                        return;
                    }
                    Action::Open(id) => Ok(id),
                    Action::ShowPicker => {
                        let picker = task_app.clone();
                        let _ = task_app.run_on_main_thread(move || {
                            let _ = show_picker(&picker);
                        });
                        return;
                    }
                    Action::Initialize { vault_id } => {
                        let runtime = task_app.clone();
                        let scheduled = task_app.run_on_main_thread(move || {
                            if let Err(error) =
                                begin_host_startup(&runtime, vault_id, Some(request_id))
                            {
                                if let Ok(mut book) = runtime.state::<Host>().book.lock() {
                                    book.startup_failed(Some(request_id), error);
                                }
                            }
                        });
                        if let Err(error) = scheduled {
                            if let Ok(mut book) = task_app.state::<Host>().book.lock() {
                                book.bootstrap_started = false;
                                book.complete_open(request_id, Err(error.into()));
                            }
                        }
                        return;
                    }
                    Action::Handoff {
                        source,
                        launch_id,
                        target,
                    } => {
                        let result = handoff(&task_app, request_id, &source, launch_id, &target);
                        if let Err(error) = &result {
                            log::error!("[vaults] handoff failed: {error}");
                        }
                        if let Ok(mut book) = task_app.state::<Host>().book.lock() {
                            book.complete_open(request_id, result);
                        }
                        return;
                    }
                    Action::RetryRecovery => {
                        if let Err(error) =
                            resume_update(&task_app, Instant::now() + RECOVERY_LIMIT)
                        {
                            report_recovery_failure(&task_app, &error);
                        }
                        let last =
                            task_app
                                .state::<Host>()
                                .book
                                .lock()
                                .ok()
                                .and_then(|mut book| {
                                    book.recovering = false;
                                    book.last.clone()
                                });
                        deliver_pending_invite_link(&task_app);
                        match last {
                            Some(id) => Ok(id),
                            None => crate::paths::app_data_root(&task_app)
                                .and_then(|root| crate::profiles::prepare_coordinator_index(&root))
                                .map(|index| index.active),
                        }
                    }
                    Action::ActivateLast => crate::paths::app_data_root(&task_app)
                        .and_then(|root| crate::profiles::prepare_coordinator_index(&root))
                        .map(|index| index.active),
                    Action::Remember { vault_id, revision } => {
                        let result = crate::paths::app_data_root(&task_app).and_then(|root| {
                            crate::profiles::remember_active_if(&root, &vault_id, || {
                                let host = task_app.state::<Host>();
                                let book = host.book.lock().map_err(|_| invalid())?;
                                Ok(book.focus_revision == revision)
                            })
                        });
                        if let Err(error) = result {
                            log::warn!("[vaults] last-used persistence failed: {error}");
                        }
                        let remembered = crate::paths::app_data_root(&task_app).and_then(|root| {
                            crate::shortcut_routing::remember(&root, &vault_id, || {
                                let host = task_app.state::<Host>();
                                let book = host.book.lock().map_err(|_| invalid())?;
                                Ok(book.focus_revision == revision)
                            })
                        });
                        if let Err(error) = remembered {
                            log::warn!("[vaults] shortcut recency persistence failed: {error}");
                        }
                        return;
                    }
                    Action::RefreshDeviceSettings => {
                        crate::coordinator_shortcuts::refresh(&task_app);
                        let runtime = task_app.clone();
                        let _ = task_app.run_on_main_thread(move || {
                            if let Err(error) = crate::desktop_settings::refresh_runtime(&runtime) {
                                log::warn!("[vaults] coordinator settings refresh failed: {error}");
                            }
                        });
                        broadcast_device_settings(&task_app);
                        return;
                    }
                    Action::Tray(command) => {
                        let result = dispatch_tray(&task_app, request_id, command);
                        if let Err(error) = &result {
                            report_capture_failure(&task_app, &error.to_string());
                        }
                        if let Ok(mut book) = task_app.state::<Host>().book.lock() {
                            book.complete_open(request_id, result);
                        }
                        return;
                    }
                    Action::InviteLink(link) => {
                        let result = dispatch_invite_link(&task_app, request_id, link);
                        if let Err(error) = &result {
                            log::error!("[deep-link] no vault took the invite link: {error}");
                        }
                        if let Ok(mut book) = task_app.state::<Host>().book.lock() {
                            book.complete_open(request_id, result);
                        }
                        return;
                    }
                    Action::Shortcut(command, accelerator) => {
                        let result = dispatch_shortcut(&task_app, request_id, command, accelerator);
                        if let Err(error) = &result {
                            log::error!("[shortcuts] action failed: {error}");
                        }
                        if let Ok(mut book) = task_app.state::<Host>().book.lock() {
                            book.complete_open(request_id, result);
                        }
                        return;
                    }
                };
                let result = target.and_then(|vault_id| {
                    if tracked_open {
                        open_and_wait(&task_app, &vault_id)
                    } else {
                        open(&task_app, &vault_id, true).map(|_| ())
                    }
                });
                if let Err(error) = &result {
                    log::error!("[vaults] open request failed: {error}");
                    if !tracked_open {
                        let picker = task_app.clone();
                        let _ = task_app.run_on_main_thread(move || {
                            let _ = show_picker(&picker);
                        });
                    }
                }
                if tracked_open {
                    if let Ok(mut book) = task_app.state::<Host>().book.lock() {
                        book.complete_open(request_id, result);
                    }
                }
            })
        {
            if let Ok(mut book) = host.book.lock() {
                book.operations.remove(&request_id);
                if book.quitting == Some(request_id) {
                    book.quitting = None;
                }
            }
            return Err(error.into());
        }
    }
    if settings_notice {
        let refresh = app.clone();
        let _ = std::thread::Builder::new()
            .name("shortcut-refresh".into())
            .spawn(move || {
                let _job = refresh_job;
                crate::coordinator_shortcuts::refresh(&refresh);
            });
    }
    Ok(reply)
}

/// Menu/tray Quit is environment-wide. Individual window close stays local.
/// Native callbacks only schedule IPC; they never wait for saves or OS work.
pub(crate) fn request_quit(app: &AppHandle) {
    if app.try_state::<Host>().is_none() && app.try_state::<Worker>().is_none() {
        app.exit(0);
        return;
    }
    let app = app.clone();
    let notification = app.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("environment-quit".into())
        .spawn(move || {
            let result = (|| -> AppResult<()> {
                let request = request(&HostCommand::Quit)?;
                if let Some(worker) = app.try_state::<Worker>() {
                    let endpoint = worker.host.lock().map_err(|_| invalid())?.clone();
                    endpoint
                        .retry_call(&request)?
                        .map_err(AppError::InvalidArg)?;
                } else {
                    handle_host(&app, request)?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                notify_quit_failure(&app, &error.to_string());
            }
        })
    {
        notify_quit_failure(&notification, &error.to_string());
    }
}

fn notify_quit_failure(app: &AppHandle, message: &str) {
    log::error!("[vaults] whole-app quit failed: {message}");
    let _ = app.emit(
        crate::app_events::AppEvent::EnvironmentQuitFailed.as_str(),
        json!({"message":message}),
    );
}

fn close_owner(
    book: &Mutex<Book>,
    root: &std::path::Path,
    id: &str,
    launch_id: Uuid,
) -> AppResult<crate::coordinator_shutdown::Owner> {
    use crate::coordinator_shutdown::Owner;
    let launch = book
        .lock()
        .map_err(|_| invalid())?
        .workers
        .get(id)
        .map(|launch| (launch.id, launch.adopted));
    if let Some((current, _)) = launch {
        if current != launch_id {
            return Ok(Owner::Changed);
        }
    }
    if launch.is_some_and(|(_, adopted)| !adopted) {
        return Ok(Owner::Present);
    }
    let directory = crate::profiles::profile_dir(root, id);
    if !directory.is_dir() {
        return Err(invalid());
    }
    // A child wait proves process exit; its physical lease must also be free.
    // An adopted worker has no wait handle, so its OS lease is the evidence.
    if let Some(_lease) = crate::storage_locks::VaultLock::try_acquire(&directory)? {
        book.lock()
            .map_err(|_| invalid())?
            .remove_launch(id, launch_id);
        Ok(Owner::Released)
    } else if launch.is_none() {
        Ok(Owner::Changed)
    } else {
        Ok(Owner::Present)
    }
}

fn close_for_quit(
    app: &AppHandle,
    root: &std::path::Path,
    id: &str,
    launch_id: Uuid,
    operation_id: Uuid,
    deadline: Instant,
) -> AppResult<()> {
    use crate::coordinator_shutdown::Owner;
    let host = app.state::<Host>();
    let ownership = || close_owner(&host.book, root, id, launch_id);
    let endpoint = loop {
        match ownership()? {
            Owner::Released => return Ok(()),
            Owner::Changed => return Err(invalid()),
            Owner::Present => {}
        }
        let ready = host
            .book
            .lock()
            .map_err(|_| invalid())?
            .ready_endpoint(id, launch_id);
        match ready {
            Ok(Some((endpoint, _))) => break endpoint,
            Ok(None) => {}
            Err(error) => {
                return if ownership()? == Owner::Released {
                    Ok(())
                } else {
                    Err(error)
                }
            }
        }
        if Instant::now() >= deadline {
            return Err(AppError::InvalidArg(
                "vault did not become ready to save before quit timed out".into(),
            ));
        }
        std::thread::sleep(Duration::from_millis(40));
    };
    let identified = (|| -> AppResult<()> {
        let reply = endpoint
            .retry_call(&request(&WorkerCommand::Identify { launch_id })?)?
            .map_err(AppError::InvalidArg)?;
        let identity: crate::worker_registration::Identity =
            serde_json::from_value(reply).map_err(|_| invalid())?;
        identity.require_compatible()?;
        if identity.launch_id != launch_id
            || identity.vault_id != id
            || !identity.ready
            || identity.root != std::fs::canonicalize(root)?
            || identity.directory != std::fs::canonicalize(crate::profiles::profile_dir(root, id))?
        {
            return Err(invalid());
        }
        Ok(())
    })();
    if let Err(error) = identified {
        return if ownership()? == Owner::Released {
            Ok(())
        } else {
            Err(error)
        };
    }
    crate::coordinator_shutdown::close(&endpoint, launch_id, operation_id, deadline, ownership)
}

fn verified_worker(
    root: &std::path::Path,
    id: &str,
    launch_id: Uuid,
    endpoint: &Endpoint,
) -> AppResult<crate::worker_registration::Identity> {
    let reply = endpoint
        .retry_call(&request(&WorkerCommand::Identify { launch_id })?)?
        .map_err(AppError::InvalidArg)?;
    let identity: crate::worker_registration::Identity =
        serde_json::from_value(reply).map_err(|_| invalid())?;
    identity.require_compatible()?;
    if identity.launch_id != launch_id
        || identity.vault_id != id
        || !identity.ready
        || identity.root != std::fs::canonicalize(root)?
        || identity.directory != std::fs::canonicalize(crate::profiles::profile_dir(root, id))?
    {
        return Err(invalid());
    }
    Ok(identity)
}

pub(crate) fn update_progress(
    app: &AppHandle,
    progress: crate::coordinator_updater::DownloadProgress,
) {
    let targets = app
        .state::<Host>()
        .book
        .lock()
        .map(|book| book.device_targets())
        .unwrap_or_default();
    for (launch_id, endpoint) in targets {
        if let Ok(request) = request(&WorkerCommand::UpdateProgress {
            launch_id,
            progress: progress.clone(),
        }) {
            let _ = endpoint.retry_call(&request);
        }
    }
}

/// The installer caller holds no tracked job of its own. Its Book fence keeps
/// the coordinator alive, and this reversible pause drains earlier root work.
pub(crate) fn drain_for_update(
    app: &AppHandle,
    operation_id: Uuid,
    target_version: &str,
) -> AppResult<crate::vault_jobs::Pause> {
    let host = app.state::<Host>();
    let root = crate::paths::app_data_root(app)?;
    let deadline = Instant::now() + Duration::from_secs(180);
    let targets: Vec<_> = host
        .book
        .lock()
        .map_err(|_| invalid())?
        .workers
        .iter()
        .map(|(id, launch)| (id.clone(), launch.id))
        .collect();
    // Readiness itself can enqueue root work. Wait before pausing root jobs.
    for (id, launch_id) in &targets {
        wait_for_ready(&host.book, id, *launch_id, deadline)?;
    }
    let pause = host.jobs.pause()?;
    pause.wait(deadline.saturating_duration_since(Instant::now()))?;
    let mut vaults = Vec::new();
    for (id, launch_id) in &targets {
        let (endpoint, _) = host
            .book
            .lock()
            .map_err(|_| invalid())?
            .ready_endpoint(id, *launch_id)?
            .ok_or_else(invalid)?;
        let identity = verified_worker(&root, id, *launch_id, &endpoint)?;
        let reply = endpoint
            .retry_call(&request(&WorkerCommand::SnapshotWindows {
                launch_id: *launch_id,
            })?)?
            .map_err(AppError::InvalidArg)?;
        vaults.push(crate::update_recovery::Vault {
            id: id.clone(),
            directory: identity.directory,
            windows: serde_json::from_value(reply).map_err(|_| invalid())?,
        });
    }
    let focus = {
        let book = host.book.lock().map_err(|_| invalid())?;
        if book.quitting != Some(operation_id) {
            return Err(invalid());
        }
        book.last.as_ref().and_then(|id| {
            let label = book
                .workers
                .get(id)?
                .focused_window
                .as_deref()
                .unwrap_or("main");
            vaults
                .iter()
                .find(|vault| &vault.id == id)?
                .windows
                .iter()
                .find(|window| window.label == label && window.visible && !window.minimized)
                .map(|window| crate::update_recovery::Focus {
                    vault_id: id.clone(),
                    window: window.label.clone(),
                })
        })
    };
    crate::update_recovery::prepare(
        &root,
        operation_id,
        &app.package_info().version.to_string(),
        target_version,
        vaults,
        focus,
    )?;
    close_targets(app, &root, &targets, operation_id, deadline)?;
    let book = host.book.lock().map_err(|_| invalid())?;
    if book.quitting != Some(operation_id) || !book.workers.is_empty() {
        return Err(invalid());
    }
    Ok(pause)
}

/// A failed attempt keeps the saved session for exactly one retry, on the next
/// launch. A second failure sets it aside, so recovery can never block opening
/// vaults for more than the attempt itself.
fn resume_update(app: &AppHandle, deadline: Instant) -> AppResult<bool> {
    let root = crate::paths::app_data_root(app)?;
    let Some(record) =
        crate::update_recovery::resume(&root, &app.package_info().version.to_string())?
    else {
        return Ok(false);
    };
    let Err(error) = restore_update_session(app, &root, &record, deadline) else {
        return Ok(true);
    };
    let outcome = match crate::update_recovery::attempt_failed(&root, record.operation_id) {
        Ok(Some(evidence)) => format!(
            "the saved windows were not reopened and the session was set aside: {}",
            evidence.display()
        ),
        Ok(None) => {
            if let Ok(mut book) = app.state::<Host>().book.lock() {
                book.update_retry = true;
            }
            "reopening the saved windows will be tried once more the next time the app is started"
                .into()
        }
        Err(count) => format!("the saved session was retained: {count}"),
    };
    Err(AppError::InvalidArg(format!("{error}; {outcome}")))
}

fn restore_update_session(
    app: &AppHandle,
    root: &std::path::Path,
    record: &crate::update_recovery::Record,
    deadline: Instant,
) -> AppResult<()> {
    let host = app.state::<Host>();
    for vault in &record.vaults {
        if Instant::now() >= deadline {
            return Err(AppError::InvalidArg(
                "reopening the saved windows took too long".into(),
            ));
        }
        // The index/deletion checks in open remain authoritative. The record
        // grants neither ownership nor permission to recreate a missing vault.
        if vault.directory != std::fs::canonicalize(crate::profiles::profile_dir(root, &vault.id))?
        {
            return Err(invalid());
        }
        let existing = host
            .book
            .lock()
            .map_err(|_| invalid())?
            .workers
            .contains_key(&vault.id);
        let launch_id = open(app, &vault.id, false)?;
        let (endpoint, _) = wait_for_ready(
            &host.book,
            &vault.id,
            launch_id,
            (Instant::now() + OPEN_TIMEOUT).min(deadline),
        )?;
        verified_worker(root, &vault.id, launch_id, &endpoint)?;
        if !existing || !record.was_restored(&vault.id) {
            let restore = request(&WorkerCommand::RestoreWindows {
                launch_id,
                vault: vault.clone(),
            })?;
            endpoint
                .retry_call(&restore)?
                .map_err(AppError::InvalidArg)?;
            let poll = request(&WorkerCommand::RestoreStatus {
                launch_id,
                operation_id: restore.id,
            })?;
            let deadline = (Instant::now() + OPEN_TIMEOUT).min(deadline);
            loop {
                let reply = endpoint.retry_call(&poll)?.map_err(AppError::InvalidArg)?;
                match serde_json::from_value::<crate::update_windows::Progress>(reply)
                    .map_err(|_| invalid())?
                {
                    crate::update_windows::Progress::Ready => break,
                    crate::update_windows::Progress::Failed { message } => {
                        return Err(AppError::InvalidArg(message))
                    }
                    crate::update_windows::Progress::Pending => {}
                }
                if Instant::now() >= deadline {
                    return Err(invalid());
                }
                std::thread::sleep(Duration::from_millis(40));
            }
        }
        crate::update_recovery::restored(root, record.operation_id, &vault.id)?;
    }
    if let Some(focus) = &record.focus {
        let (launch_id, endpoint) = {
            let book = host.book.lock().map_err(|_| invalid())?;
            let launch = book.workers.get(&focus.vault_id).ok_or_else(invalid)?;
            (launch.id, launch.endpoint.clone().ok_or_else(invalid)?)
        };
        activate_worker(
            root,
            &crate::profiles::profile_dir(root, &focus.vault_id),
            &focus.vault_id,
            launch_id,
            &endpoint,
            Some(focus.window.clone()),
        )?;
    }
    crate::update_recovery::consume(root, record.operation_id)?;
    // An empty saved session is still a completed startup. Arm normal idle
    // exit instead of retaining a headless coordinator as a failed first boot.
    host.book.lock().map_err(|_| invalid())?.had_ready_worker = true;
    Ok(())
}

pub(crate) fn update_failed(app: &AppHandle, operation_id: Uuid, error: AppError) {
    let host = app.state::<Host>();
    // Keep idle shutdown from winning between releasing the install fence and
    // reserving recovery workers. The reversible drain has already dropped.
    let _recovery_job = host.jobs.enter();
    if let Ok(mut book) = host.book.lock() {
        book.complete_open(operation_id, Err(AppError::InvalidArg(error.to_string())));
        if book.quitting == Some(operation_id) {
            book.quitting = None;
        }
    }
    if let Ok(root) = crate::paths::app_data_root(app) {
        // A download failure has no journal. A failed close/install retains
        // the record and restores already-closed vaults in the old binary.
        if crate::update_recovery::failed(&root, operation_id).is_ok() {
            if let Ok(mut book) = host.book.lock() {
                book.recovering = true;
            }
            if let Err(recovery) = resume_update(app, Instant::now() + RECOVERY_LIMIT) {
                log::error!("[updater] failed-install recovery incomplete: {recovery}");
            }
            // Vaults that were not reopened stay reachable by hand.
            if let Ok(mut book) = host.book.lock() {
                book.recovering = false;
            }
        }
    }
    crate::coordinator_shortcuts::suspend(app, false);
    notify_quit_failure(app, &format!("Update failed: {error}"));
    let targets = host
        .book
        .lock()
        .map(|book| book.device_targets())
        .unwrap_or_default();
    for (launch_id, endpoint) in &targets {
        if let Ok(request) = request(&WorkerCommand::QuitFailed {
            launch_id: *launch_id,
            message: format!("Update failed: {error}"),
        }) {
            let _ = endpoint.retry_call(&request);
        }
    }
    if targets.is_empty() {
        use tauri_plugin_dialog::DialogExt;
        app.dialog().message(format!("The update could not finish. Your recovery information has been retained.\n\n{error}"))
            .title("Update failed").show(|_| {});
    }
}

fn clear_handoff(app: &AppHandle, id: Uuid) {
    if let Ok(mut book) = app.state::<Host>().book.lock() {
        if book.handoff == Some(id) {
            book.handoff = None;
        }
    }
    crate::coordinator_shortcuts::suspend(app, false);
}

fn cancel_handoff_source(
    app: &AppHandle,
    root: &std::path::Path,
    record: &crate::vault_handoff::Record,
) -> AppResult<bool> {
    use crate::coordinator_shutdown::Owner;
    let host = app.state::<Host>();
    match close_owner(&host.book, root, &record.source.id, record.source.launch_id)? {
        Owner::Released => return Ok(false),
        Owner::Changed => {
            return Err(AppError::InvalidArg(
                "the source owner changed; no replacement source was closed".into(),
            ))
        }
        Owner::Present => {}
    }
    let (endpoint, _) = host
        .book
        .lock()
        .map_err(|_| invalid())?
        .ready_endpoint(&record.source.id, record.source.launch_id)?
        .ok_or_else(invalid)?;
    verified_worker(root, &record.source.id, record.source.launch_id, &endpoint)?;
    endpoint
        .retry_call(&request(&WorkerCommand::CancelClose {
            launch_id: record.source.launch_id,
            operation_id: record.source_close,
        })?)?
        .map_err(AppError::InvalidArg)?;
    Ok(true)
}

fn cancel_handoff_target(
    app: &AppHandle,
    root: &std::path::Path,
    record: &crate::vault_handoff::Record,
) -> AppResult<()> {
    // This never closes a target process that appeared under a different UUID.
    close_for_quit(
        app,
        root,
        &record.target.id,
        record.target.launch_id,
        record.target_close,
        Instant::now() + OPEN_TIMEOUT,
    )
}

fn abort_handoff(
    app: &AppHandle,
    root: &std::path::Path,
    record: &crate::vault_handoff::Record,
) -> AppResult<()> {
    if close_owner(
        &app.state::<Host>().book,
        root,
        &record.target.id,
        record.target.launch_id,
    )? != crate::coordinator_shutdown::Owner::Changed
    {
        // Keep the intent active until this prepared worker has actually exited.
        // A later recovery pass can retry without losing its identity evidence.
        cancel_handoff_target(app, root, record)?;
    }
    crate::vault_handoff::advance(
        root,
        record.operation_id,
        crate::vault_handoff::Phase::Cancelled,
    )?;
    clear_handoff(app, record.operation_id);
    Ok(())
}

fn prepare_handoff_target(
    app: &AppHandle,
    root: &std::path::Path,
    mut record: crate::vault_handoff::Record,
) -> AppResult<crate::vault_handoff::Record> {
    record.verify_paths(root)?;
    let host = app.state::<Host>();
    let present = host
        .book
        .lock()
        .map_err(|_| invalid())?
        .workers
        .get(&record.target.id)
        .map(|worker| worker.id);
    if let Some(id) = present {
        if id != record.target.launch_id {
            return Err(invalid());
        }
    } else {
        // Drop the physical probe before any publication/IPC. A racing foreign
        // owner is still rejected by the worker's own lifetime OS lease.
        let free =
            crate::storage_locks::VaultLock::try_acquire(&record.target.directory)?.is_some();
        if !free {
            return Err(invalid());
        }
        record = crate::vault_handoff::replace_target(root, record.operation_id)?;
    }
    let launch_id = open_with_launch(app, &record.target.id, false, Some(record.target.launch_id))?;
    let (endpoint, _) = wait_for_ready(
        &host.book,
        &record.target.id,
        launch_id,
        Instant::now() + OPEN_TIMEOUT,
    )?;
    verified_worker(root, &record.target.id, launch_id, &endpoint)?;
    restore_handoff_window(&endpoint, launch_id, &record, false)?;
    Ok(record)
}

fn restore_handoff_window(
    endpoint: &Endpoint,
    launch_id: Uuid,
    record: &crate::vault_handoff::Record,
    visible: bool,
) -> AppResult<()> {
    let mut geometry = record.geometry.clone();
    geometry.visible = visible;
    geometry.minimized = false;
    let restore = Request {
        id: if visible {
            record.activation_restore
        } else {
            record.restore
        },
        payload: serde_json::to_value(WorkerCommand::RestoreWindows {
            launch_id,
            vault: crate::update_recovery::Vault {
                id: record.target.id.clone(),
                directory: record.target.directory.clone(),
                windows: vec![geometry],
            },
        })
        .map_err(|_| invalid())?,
    };
    endpoint
        .retry_call(&restore)?
        .map_err(AppError::InvalidArg)?;
    let poll = request(&WorkerCommand::RestoreStatus {
        launch_id,
        operation_id: if visible {
            record.activation_restore
        } else {
            record.restore
        },
    })?;
    let deadline = Instant::now() + OPEN_TIMEOUT;
    loop {
        let value = endpoint.retry_call(&poll)?.map_err(AppError::InvalidArg)?;
        match serde_json::from_value::<crate::update_windows::Progress>(value)
            .map_err(|_| invalid())?
        {
            crate::update_windows::Progress::Ready => break,
            crate::update_windows::Progress::Failed { message } => {
                return Err(AppError::InvalidArg(message))
            }
            crate::update_windows::Progress::Pending => {}
        }
        if Instant::now() >= deadline {
            return Err(invalid());
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    Ok(())
}

fn commit_handoff(
    app: &AppHandle,
    root: &std::path::Path,
    record: crate::vault_handoff::Record,
) -> AppResult<()> {
    let record = prepare_handoff_target(app, root, record)?;
    let (endpoint, _) = app
        .state::<Host>()
        .book
        .lock()
        .map_err(|_| invalid())?
        .ready_endpoint(&record.target.id, record.target.launch_id)?
        .ok_or_else(invalid)?;
    restore_handoff_window(&endpoint, record.target.launch_id, &record, true)?;
    activate_worker(
        root,
        &record.target.directory,
        &record.target.id,
        record.target.launch_id,
        &endpoint,
        Some("main".into()),
    )?;
    crate::profiles::set_active(root, &record.target.id)?;
    crate::vault_handoff::advance(
        root,
        record.operation_id,
        crate::vault_handoff::Phase::Completed,
    )?;
    clear_handoff(app, record.operation_id);
    Ok(())
}

fn handoff(
    app: &AppHandle,
    id: Uuid,
    source: &str,
    source_launch: Uuid,
    target: &str,
) -> AppResult<()> {
    use crate::vault_handoff::{Phase, Worker};
    let root = crate::paths::app_data_root(app)?;
    crate::coordinator_shortcuts::suspend(app, true);
    let result = (|| -> AppResult<()> {
        let host = app.state::<Host>();
        reconcile_adopted(&host.book, &root)?;
        let existing = host
            .book
            .lock()
            .map_err(|_| invalid())?
            .workers
            .contains_key(target);
        if source == target || existing {
            // An already-open target always focuses without closing its source,
            // including a target that became open after the menu observation.
            open_and_wait(app, target)?;
            clear_handoff(app, id);
            return Ok(());
        }
        let (endpoint, _) = host
            .book
            .lock()
            .map_err(|_| invalid())?
            .ready_endpoint(source, source_launch)?
            .ok_or_else(invalid)?;
        let source_identity = verified_worker(&root, source, source_launch, &endpoint)?;
        let index = crate::profiles::prepare_coordinator_index(&root)?;
        if !index.profiles.iter().any(|vault| vault.id == target) {
            return Err(invalid());
        }
        let snapshot = endpoint
            .retry_call(&request(&WorkerCommand::SnapshotWindows {
                launch_id: source_launch,
            })?)?
            .map_err(AppError::InvalidArg)?;
        let windows: Vec<crate::update_recovery::Window> =
            serde_json::from_value(snapshot).map_err(|_| invalid())?;
        let geometry = windows
            .into_iter()
            .find(|window| window.label == "main")
            .ok_or_else(invalid)?;
        let record = crate::vault_handoff::prepare(
            &root,
            id,
            Worker {
                id: source.into(),
                launch_id: source_launch,
                directory: source_identity.directory,
            },
            Worker {
                id: target.into(),
                launch_id: Uuid::new_v4(),
                directory: std::fs::canonicalize(crate::profiles::profile_dir(&root, target))?,
            },
            geometry,
        )?;
        prepare_handoff_target(app, &root, record)?;
        let record = crate::vault_handoff::advance(&root, id, Phase::Closing)?;
        // The intent is durable before the close can be queued. Every source
        // main/popout save and both service drains finish before lease release.
        close_for_quit(
            app,
            &root,
            source,
            source_launch,
            record.source_close,
            Instant::now() + Duration::from_secs(120),
        )?;
        let record = crate::vault_handoff::advance(&root, id, Phase::Closed)?;
        commit_handoff(app, &root, record)
    })();
    if result.is_err() {
        match crate::vault_handoff::load(&root)? {
            Some(record) if record.operation_id == id && record.active() => {
                if matches!(record.phase, Phase::Preparing | Phase::Closing) {
                    match cancel_handoff_source(app, &root, &record) {
                        Ok(true) => abort_handoff(app, &root, &record)?,
                        Ok(false) if record.phase == Phase::Closing => {
                            let record = crate::vault_handoff::advance(&root, id, Phase::Closed)?;
                            // Source exit may have raced a lost acknowledgement.
                            // Finishing the target is now the confirmed policy.
                            return commit_handoff(app, &root, record);
                        }
                        Ok(false) => {
                            abort_handoff(app, &root, &record)?;
                            open_and_wait(app, &record.source.id)?;
                        }
                        Err(error) => log::warn!("[vaults] close outcome uncertain; handoff intent retained for recovery: {error}"),
                    }
                }
            }
            _ => clear_handoff(app, id),
        }
    }
    result
}

fn resume_handoff(app: &AppHandle) -> AppResult<bool> {
    use crate::coordinator_shutdown::Owner;
    use crate::vault_handoff::Phase;
    let root = crate::paths::app_data_root(app)?;
    let Some(record) = crate::vault_handoff::load(&root)?.filter(|record| record.active()) else {
        return Ok(false);
    };
    record.verify_paths(&root)?;
    let host = app.state::<Host>();
    host.book.lock().map_err(|_| invalid())?.handoff = Some(record.operation_id);
    crate::coordinator_shortcuts::suspend(app, true);
    if record.phase == Phase::Closed {
        commit_handoff(app, &root, record)?;
        return Ok(true);
    }
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        match close_owner(
            &host.book,
            &root,
            &record.source.id,
            record.source.launch_id,
        )? {
            Owner::Released if record.phase == Phase::Closing => {
                let record =
                    crate::vault_handoff::advance(&root, record.operation_id, Phase::Closed)?;
                commit_handoff(app, &root, record)?;
                return Ok(true);
            }
            Owner::Released => {
                abort_handoff(app, &root, &record)?;
                open_and_wait(app, &record.source.id)?;
                return Ok(true);
            }
            Owner::Changed => {
                // A different source is preserved. It does not inherit the old
                // worker's close request or grant permission to force a close.
                abort_handoff(app, &root, &record)?;
                return Ok(true);
            }
            Owner::Present => {
                if cancel_handoff_source(app, &root, &record).is_ok_and(|kept| kept) {
                    abort_handoff(app, &root, &record)?;
                    open_and_wait(app, &record.source.id)?;
                    return Ok(true);
                }
            }
        }
        if Instant::now() >= deadline {
            return Err(invalid());
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

fn close_targets(
    app: &AppHandle,
    root: &std::path::Path,
    targets: &[(String, Uuid)],
    operation_id: Uuid,
    deadline: Instant,
) -> AppResult<()> {
    let mut errors = Vec::new();
    for chunk in targets.chunks(8) {
        std::thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|(id, launch)| {
                    scope.spawn(move || {
                        close_for_quit(app, root, id, *launch, operation_id, deadline)
                            .map_err(|error| format!("{id}: {error}"))
                    })
                })
                .collect();
            for handle in handles {
                match handle.join() {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => errors.push(error),
                    Err(_) => errors.push("worker close task failed; ownership retained".into()),
                }
            }
        });
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(AppError::InvalidArg(errors.join("; ")))
    }
}

fn finish_quit(app: &AppHandle, operation_id: Uuid) {
    let host = app.state::<Host>();
    crate::coordinator_shortcuts::suspend(app, true);
    let result = (|| -> AppResult<()> {
        let root = crate::paths::app_data_root(app)?;
        let deadline = Instant::now() + Duration::from_secs(180);
        let targets: Vec<_> = host
            .book
            .lock()
            .map_err(|_| invalid())?
            .workers
            .iter()
            .map(|(id, launch)| (id.clone(), launch.id))
            .collect();
        close_targets(app, &root, &targets, operation_id, deadline)?;
        let pause = host.jobs.pause()?;
        pause.wait(deadline.saturating_duration_since(Instant::now()))?;
        let mut book = host.book.lock().map_err(|_| invalid())?;
        if book.quitting != Some(operation_id) || !book.workers.is_empty() {
            return Err(invalid());
        }
        crate::vault_jobs::Pause::commit_all(vec![pause])?;
        book.complete_open(operation_id, Ok(()));
        Ok(())
    })();
    match result {
        Ok(()) => app.exit(0),
        Err(error) => {
            if let Ok(mut book) = host.book.lock() {
                book.complete_open(operation_id, Err(AppError::InvalidArg(error.to_string())));
                if book.quitting == Some(operation_id) {
                    book.quitting = None;
                }
            }
            crate::coordinator_shortcuts::suspend(app, false);
            notify_quit_failure(app, &error.to_string());
            let targets = host
                .book
                .lock()
                .map(|book| book.device_targets())
                .unwrap_or_default();
            for (launch_id, endpoint) in targets {
                if let Ok(request) = request(&WorkerCommand::QuitFailed {
                    launch_id,
                    message: error.to_string(),
                }) {
                    let _ = endpoint.retry_call(&request);
                }
            }
        }
    }
}

pub(crate) fn shortcut_destination_available(app: &AppHandle) -> AppResult<bool> {
    let host = app.state::<Host>();
    let book = host.book.lock().map_err(|_| invalid())?;
    if !book.exported || book.quitting.is_some() {
        return Ok(false);
    }
    let recent = book.shortcut_order.clone();
    drop(book);
    Ok(matches!(
        crate::shortcut_routing::select(&crate::paths::app_data_root(app)?, &recent)?,
        crate::shortcut_routing::Selection::Target { .. }
    ))
}

pub(crate) fn shortcut_registration_status(
    app: &AppHandle,
) -> AppResult<crate::coordinator_shortcuts::Status> {
    let worker = app.state::<Worker>();
    let host = worker.host.lock().map_err(|_| invalid())?.clone();
    let value = host
        .retry_call(&request(&HostCommand::ShortcutRegistrationStatus)?)?
        .map_err(AppError::InvalidArg)?;
    serde_json::from_value(value).map_err(|_| invalid())
}

fn host_shortcut_status(app: &AppHandle) -> AppResult<crate::coordinator_shortcuts::Status> {
    let mut status = crate::coordinator_shortcuts::status(app)?;
    if status.error.is_none() {
        let host = app.state::<Host>();
        let book = host.book.lock().map_err(|_| invalid())?;
        status.error = book
            .operations
            .values()
            .filter(|operation| operation.input["command"].as_str() == Some("shortcut"))
            .max_by_key(|operation| operation.at)
            .and_then(|operation| match &operation.open_result {
                Some(Err(message)) => Some(message.clone()),
                _ => None,
            });
    }
    Ok(status)
}

pub(crate) fn run_tray(app: &AppHandle, action: crate::shortcut_actions::TrayCommand) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("tray-capture".into())
        .spawn(move || {
            if let Ok(request) = request(&HostCommand::Tray { action }) {
                if let Err(error) = handle_host(&app, request) {
                    report_capture_failure(&app, &error.to_string());
                }
            }
        });
}

fn report_capture_failure(app: &AppHandle, message: &str) {
    log::error!("[tray] capture failed: {message}");
    let _ = app.emit(
        crate::app_events::AppEvent::CaptureFailed.as_str(),
        json!({"message":message}),
    );
    let targets = app
        .state::<Host>()
        .book
        .lock()
        .map(|book| book.device_targets())
        .unwrap_or_default();
    if targets.is_empty() {
        use tauri_plugin_dialog::DialogExt;
        app.dialog()
            .message(message)
            .title("Mindstream Notes")
            .show(|_| {});
    } else {
        for (launch_id, endpoint) in targets {
            if let Ok(request) = request(&WorkerCommand::CaptureFailed {
                launch_id,
                message: message.into(),
            }) {
                let _ = endpoint.retry_call(&request);
            }
        }
    }
}

fn tray_destination(book: &Book, index: &crate::profiles::Index) -> AppResult<String> {
    if !book.exported || book.quitting.is_some() {
        return Err(invalid());
    }
    // Keep the latest known closed-vault focus until its asynchronous root
    // persistence finishes. Last-open focus still wins while workers exist.
    let recent_closed = book
        .shortcut_order
        .iter()
        .rev()
        .find(|id| index.profiles.iter().any(|vault| vault.id == **id));
    let id = book
        .last
        .as_ref()
        .or(recent_closed)
        .unwrap_or(&index.active);
    if !index.profiles.iter().any(|vault| vault.id == *id) {
        return Err(AppError::InvalidArg(
            "the last-used tray vault is unavailable".into(),
        ));
    }
    Ok(id.clone())
}

fn dispatch_tray(
    app: &AppHandle,
    request_id: Uuid,
    action: crate::shortcut_actions::TrayCommand,
) -> AppResult<()> {
    let (endpoint, launch_id) = ready_tray_destination(app)?;
    crate::foreground::transfer(&endpoint);
    endpoint
        .retry_call(&Request {
            id: request_id,
            payload: serde_json::to_value(WorkerCommand::Tray { launch_id, action })
                .map_err(|_| invalid())?,
        })?
        .map(|_| ())
        .map_err(AppError::InvalidArg)
}

/// An invite link opened outside the app, handed to this coordinator. It
/// goes to a vault from a thread of its own; native callbacks never wait.
pub(crate) fn run_invite_link(app: &AppHandle, link: String) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("invite-link".into())
        .spawn(move || {
            if let Ok(request) = request(&HostCommand::InviteLink { link }) {
                if let Err(error) = handle_host(&app, request) {
                    log::error!("[deep-link] invite link not accepted: {error}");
                }
            }
        });
}

/// Startup kept a link that arrived before any vault could take it.
fn deliver_pending_invite_link(app: &AppHandle) {
    let link = app
        .state::<Host>()
        .book
        .lock()
        .ok()
        .and_then(|mut book| book.pending_invite_link.take());
    if let Some(link) = link {
        run_invite_link(app, link);
    }
}

/// The vault the tray would capture into shows the link. A link is not
/// tied to any one vault; the user decides there where the folder goes.
fn dispatch_invite_link(app: &AppHandle, request_id: Uuid, link: String) -> AppResult<()> {
    let (endpoint, launch_id) = ready_tray_destination(app)?;
    crate::foreground::transfer(&endpoint);
    endpoint
        .retry_call(&Request {
            id: request_id,
            payload: serde_json::to_value(WorkerCommand::InviteLink { launch_id, link })
                .map_err(|_| invalid())?,
        })?
        .map(|_| ())
        .map_err(AppError::InvalidArg)
}

/// Open the tray's vault if needed and wait until its worker is ready.
fn ready_tray_destination(app: &AppHandle) -> AppResult<(Endpoint, Uuid)> {
    let root = crate::paths::app_data_root(app)?;
    let index = crate::profiles::prepare_coordinator_index(&root)?;
    let vault_id = {
        let host = app.state::<Host>();
        let book = host.book.lock().map_err(|_| invalid())?;
        tray_destination(&book, &index)?
    };
    let directory = std::fs::canonicalize(crate::profiles::profile_dir(&root, &vault_id))?;
    // Pin this destination before startup. Focus changes and failures never
    // turn the same request into a write in another vault.
    let launch_id = open(app, &vault_id, false)?;
    let (endpoint, _) = wait_for_ready(
        &app.state::<Host>().book,
        &vault_id,
        launch_id,
        Instant::now() + OPEN_TIMEOUT,
    )?;
    let reply = endpoint
        .retry_call(&request(&WorkerCommand::Identify { launch_id })?)?
        .map_err(AppError::InvalidArg)?;
    let identity: crate::worker_registration::Identity =
        serde_json::from_value(reply).map_err(|_| invalid())?;
    identity.require_compatible()?;
    if !identity.ready
        || identity.launch_id != launch_id
        || identity.vault_id != vault_id
        || identity.directory != directory
        || identity.root != std::fs::canonicalize(&root)?
    {
        return Err(invalid());
    }
    Ok((endpoint, launch_id))
}

pub(crate) fn run_shortcut(
    app: &AppHandle,
    command_id: crate::hotkeys::GlobalShortcutCommandId,
    accelerator: String,
) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("global-shortcut".into())
        .spawn(move || {
            if let Ok(request) = request(&HostCommand::Shortcut {
                command_id,
                accelerator: Some(accelerator),
            }) {
                if let Err(error) = handle_host(&app, request) {
                    log::error!("[shortcuts] request rejected: {error}");
                }
            }
        });
}

fn dispatch_shortcut(
    app: &AppHandle,
    request_id: Uuid,
    command_id: crate::hotkeys::GlobalShortcutCommandId,
    accelerator: Option<String>,
) -> AppResult<()> {
    let root = crate::paths::app_data_root(app)?;
    {
        let _lock = crate::storage_locks::RootLock::acquire(&root)?;
        crate::coordinator_shortcuts::require_current_binding(
            &root,
            command_id,
            accelerator.as_deref(),
        )?;
    }
    let recent = app
        .state::<Host>()
        .book
        .lock()
        .map_err(|_| invalid())?
        .shortcut_order
        .clone();
    let (selection, directory) = crate::shortcut_routing::select_with_directory(&root, &recent)?;
    let crate::shortcut_routing::Selection::Target { vault_id, .. } = selection else {
        return Err(AppError::InvalidArg(
            "no vault has global shortcuts enabled".into(),
        ));
    };
    let directory = directory.ok_or_else(invalid)?;
    let launch_id = open(app, &vault_id, false)?;
    let (endpoint, _) = wait_for_ready(
        &app.state::<Host>().book,
        &vault_id,
        launch_id,
        Instant::now() + OPEN_TIMEOUT,
    )?;
    let identity = endpoint
        .retry_call(&request(&WorkerCommand::Identify { launch_id })?)?
        .map_err(AppError::InvalidArg)?;
    let identity: crate::worker_registration::Identity =
        serde_json::from_value(identity).map_err(|_| invalid())?;
    identity.require_compatible()?;
    if !identity.ready
        || identity.launch_id != launch_id
        || identity.vault_id != vault_id
        || identity.directory != directory
        || identity.root != std::fs::canonicalize(&root)?
    {
        return Err(invalid());
    }
    crate::foreground::transfer(&endpoint);
    let request = Request {
        id: request_id,
        payload: serde_json::to_value(WorkerCommand::Shortcut {
            launch_id,
            command_id,
            accelerator,
        })
        .map_err(|_| invalid())?,
    };
    endpoint
        .retry_call(&request)?
        .map(|_| ())
        .map_err(AppError::InvalidArg)
}

/// Adopted workers have no child wait handle in this host. Status and launch
/// routing prune only launches whose physical vault OS lease can be acquired.
/// A failed socket, PID or stale registration file never removes an owner.
fn reconcile_adopted(book: &Mutex<Book>, root: &std::path::Path) -> AppResult<()> {
    let candidates: Vec<_> = book
        .lock()
        .map_err(|_| invalid())?
        .workers
        .iter()
        .filter(|(_, launch)| launch.adopted)
        .map(|(id, launch)| (id.clone(), launch.id))
        .collect();
    for (id, launch_id) in candidates {
        let directory = crate::profiles::profile_dir(root, &id);
        if !directory.is_dir() {
            continue;
        }
        // Do not recreate a deleted vault or touch root documents here. Keep
        // unknown/pending-deletion owners for their explicit recovery path.
        let released = match crate::storage_locks::VaultLock::try_acquire(&directory) {
            Ok(Some(_owner)) => true,
            Ok(None) => false,
            Err(error) => {
                log::warn!("[vaults] adopted ownership reconciliation unavailable: {error}");
                false
            }
        };
        if released {
            book.lock()
                .map_err(|_| invalid())?
                .remove_launch(&id, launch_id);
        }
    }
    Ok(())
}

fn open(app: &AppHandle, vault_id: &str, activate: bool) -> AppResult<Uuid> {
    open_with_launch(app, vault_id, activate, None)
}

fn open_with_launch(
    app: &AppHandle,
    vault_id: &str,
    activate: bool,
    expected: Option<Uuid>,
) -> AppResult<Uuid> {
    let root = crate::paths::app_data_root(app)?;
    let index = crate::profiles::prepare_coordinator_index(&root)?;
    if !index.profiles.iter().any(|vault| vault.id == vault_id) {
        return Err(invalid());
    }
    let directory = crate::profiles::profile_dir(&root, vault_id);
    if !directory.is_dir() {
        return Err(invalid());
    }
    // Complete fallible preparation before reserving the launch. A filesystem
    // error must not leave a vault permanently marked as starting.
    #[cfg(windows)]
    let identity = crate::browser_identity::Identity::for_vault(&root, vault_id, &directory)?;
    let executable = std::env::current_exe()?;
    let host = app.state::<Host>();
    let mut book = host.book.lock().map_err(|_| invalid())?;
    if !book.exported || book.quitting.is_some() {
        return Err(invalid());
    }
    if let Some(launch) = book.workers.get_mut(vault_id) {
        if expected.is_some_and(|id| id != launch.id) {
            return Err(invalid());
        }
        if activate && !launch.ready {
            launch.activate_on_ready = true;
        }
        let launch_id = launch.id;
        let error = launch.error.clone();
        let adopted_pending = launch.adopted && !launch.ready;
        let focused_window = launch.focused_window.clone();
        let endpoint = launch.ready.then(|| launch.endpoint.clone()).flatten();
        drop(book);
        if let Some(error) = error {
            return retry_after_released_owner(
                app,
                &root,
                vault_id,
                launch_id,
                AppError::InvalidArg(error),
                activate,
            );
        }
        if adopted_pending {
            let directory = crate::profiles::profile_dir(&root, vault_id);
            if matches!(
                crate::worker_registration::reconcile(&root, vault_id, &directory)?,
                crate::worker_registration::Recovery::Vacant
            ) {
                host.book
                    .lock()
                    .map_err(|_| invalid())?
                    .remove_launch(vault_id, launch_id);
                return open(app, vault_id, activate);
            }
        }
        if let Some(endpoint) = endpoint.filter(|_| activate) {
            if let Err(error) = activate_worker(
                &root,
                &directory,
                vault_id,
                launch_id,
                &endpoint,
                focused_window,
            ) {
                return retry_after_released_owner(
                    app, &root, vault_id, launch_id, error, activate,
                );
            }
        }
        return Ok(launch_id);
    }
    let launch_id = expected.unwrap_or_else(Uuid::new_v4);
    book.workers.insert(
        vault_id.into(),
        Launch {
            id: launch_id,
            endpoint: None,
            ready: false,
            activate_on_ready: activate,
            error: None,
            adopted: false,
            focused_window: None,
        },
    );
    drop(book);
    let mut command = Command::new(executable);
    // The index and vault ID were validated above; worker arguments contain no
    // filesystem operations. Release the reservation if validation ever fails.
    let arguments = match Role::worker_arguments(vault_id, launch_id, host.instance) {
        Ok(arguments) => arguments,
        Err(error) => {
            host.book
                .lock()
                .map_err(|_| invalid())?
                .remove_launch(vault_id, launch_id);
            return Err(error);
        }
    };
    command.args(arguments);
    // Override inherited test/legacy folders before WebView2 starts. Changing a
    // process environment after the runtime creates threads would be unsafe.
    #[cfg(windows)]
    command.env("WEBVIEW2_USER_DATA_FOLDER", &identity.directory);
    command
        .env_remove(crate::profiles::PROFILE_DIR_ENV)
        .env_remove(crate::profiles::PROFILE_ID_ENV);
    // Start the monitor before creating the child, so thread creation failure
    // cannot leave a live worker without its exit observer.
    let task_app = app.clone();
    let task_vault = vault_id.to_owned();
    if let Err(error) = std::thread::Builder::new()
        .name("vault-worker-exit".into())
        .spawn(move || {
            let (result, released) = match command.spawn() {
                Ok(mut child) => {
                    let result = child.wait();
                    let released = result.is_ok();
                    (result, released)
                }
                Err(error) => (Err(error), true),
            };
            // wait failure does not prove exit. Retain the launch rather than
            // treating an unknown live owner as gone.
            if released {
                if let Some(host) = task_app.try_state::<Host>() {
                    if let Ok(mut book) = host.book.lock() {
                        book.remove_launch(&task_vault, launch_id);
                    }
                }
            }
            match result {
                Ok(status) if !status.success() => {
                    log::warn!("[vaults] worker exited unsuccessfully")
                }
                Err(error) => log::warn!("[vaults] worker launch or wait failed: {error}"),
                _ => {}
            }
        })
    {
        host.book
            .lock()
            .map_err(|_| invalid())?
            .remove_launch(vault_id, launch_id);
        return Err(error.into());
    }
    Ok(launch_id)
}

const OPEN_TIMEOUT: Duration = Duration::from_secs(90);
/// The host has stopped waiting by now. A worker still unready is abandoned.
const STARTUP_LIMIT: Duration = Duration::from_secs(120);
const STARTUP_FAILURE_MAX: usize = 512;
/// Startup recovery as a whole. Past this it counts as failed, not as running.
const RECOVERY_LIMIT: Duration = Duration::from_secs(300);
const HANDOFF_RETRIES: u32 = 3;

fn wait_for_ready(
    book: &Mutex<Book>,
    vault_id: &str,
    launch_id: Uuid,
    deadline: Instant,
) -> AppResult<(Endpoint, Option<String>)> {
    loop {
        if let Some(endpoint) = book
            .lock()
            .map_err(|_| invalid())?
            .ready_endpoint(vault_id, launch_id)?
        {
            return Ok(endpoint);
        }
        if Instant::now() >= deadline {
            return Err(AppError::InvalidArg(
                "vault opening timed out; any running worker has been left intact".into(),
            ));
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

fn open_and_wait(app: &AppHandle, vault_id: &str) -> AppResult<()> {
    open_and_wait_with_activation(app, vault_id, true)
}

fn open_and_wait_with_activation(app: &AppHandle, vault_id: &str, activate: bool) -> AppResult<()> {
    let deadline = Instant::now() + OPEN_TIMEOUT;
    let launch_id = open(app, vault_id, false)?;
    let host = app.state::<Host>();
    let (endpoint, window) = wait_for_ready(&host.book, vault_id, launch_id, deadline)?;
    if !activate {
        return Ok(());
    }
    let root = crate::paths::app_data_root(app)?;
    activate_worker(
        &root,
        &crate::profiles::profile_dir(&root, vault_id),
        vault_id,
        launch_id,
        &endpoint,
        window,
    )
}

fn activate_worker(
    root: &std::path::Path,
    directory: &std::path::Path,
    vault_id: &str,
    launch_id: Uuid,
    endpoint: &Endpoint,
    window: Option<String>,
) -> AppResult<()> {
    let reply = endpoint
        .retry_call(&request(&WorkerCommand::Identify { launch_id })?)?
        .map_err(AppError::InvalidArg)?;
    let identity: crate::worker_registration::Identity =
        serde_json::from_value(reply).map_err(|_| invalid())?;
    identity.require_compatible()?;
    if identity.launch_id != launch_id
        || identity.vault_id != vault_id
        || !identity.ready
        || identity.root != std::fs::canonicalize(root)?
        || identity.directory != std::fs::canonicalize(directory)?
    {
        return Err(invalid());
    }
    crate::foreground::transfer(endpoint);
    endpoint
        .retry_call(&request(&WorkerCommand::Activate { window })?)?
        .map(|_| ())
        .map_err(AppError::InvalidArg)
}

fn retry_after_released_owner(
    app: &AppHandle,
    root: &std::path::Path,
    id: &str,
    launch_id: Uuid,
    error: AppError,
    activate: bool,
) -> AppResult<Uuid> {
    // An adopted process has no child wait handle in this host. A failed RPC
    // only permits retry after the OS grants ownership; a hung worker keeps it.
    let directory = crate::profiles::profile_dir(root, id);
    match crate::worker_registration::reconcile(root, id, &directory)? {
        crate::worker_registration::Recovery::Held(_) => Err(error),
        crate::worker_registration::Recovery::Vacant => {
            app.state::<Host>()
                .book
                .lock()
                .map_err(|_| invalid())?
                .remove_launch(id, launch_id);
            open(app, id, activate)
        }
    }
}

pub fn authorize_worker(app: &AppHandle, role: &Role) -> AppResult<()> {
    let Role::Worker {
        vault_id,
        launch_id,
        coordinator_id,
    } = role
    else {
        return Err(invalid());
    };
    let host = Endpoint::read(&crate::paths::app_data_root(app)?)?;
    if host.instance() != *coordinator_id {
        return Err(invalid());
    }
    let status = host
        .retry_call(&request(&HostCommand::Status)?)?
        .map_err(AppError::InvalidArg)?;
    require_host_contract(&status)?;
    host.retry_call(&request(&HostCommand::Authorize {
        vault_id: vault_id.clone(),
        launch_id: *launch_id,
        coordinator_id: *coordinator_id,
        contract: RuntimeContract::current().clone(),
    })?)?
    .map_err(AppError::InvalidArg)?;
    Ok(())
}

fn require_host_contract(status: &Value) -> AppResult<()> {
    let contract: RuntimeContract =
        serde_json::from_value(status["contract"].clone()).map_err(|_| invalid())?;
    if &contract != RuntimeContract::current() {
        return Err(AppError::InvalidArg(
            "app coordinator uses an incompatible build; close existing app windows and restart"
                .into(),
        ));
    }
    Ok(())
}

pub fn register_worker(
    app: &AppHandle,
    role: &Role,
    ownership: &crate::storage_locks::VaultLock,
) -> AppResult<()> {
    let Role::Worker {
        vault_id,
        launch_id,
        coordinator_id,
    } = role
    else {
        return Err(invalid());
    };
    let host = Endpoint::read(&crate::paths::app_data_root(app)?)?;
    if host.instance() != *coordinator_id {
        return Err(invalid());
    }
    let listener = ipc::Coordinator::for_worker(ownership)?;
    let endpoint = listener.endpoint().clone();
    let root = crate::paths::app_data_root(app)?;
    let registration = crate::worker_registration::Registration::new(
        &root,
        vault_id,
        ownership,
        *launch_id,
        endpoint.clone(),
    )?;
    registration.publish(ownership)?;
    let registration = Arc::new(registration);
    let ready = Arc::new(AtomicBool::new(false));
    let last_window = Arc::new(Mutex::new(None));
    let host = Arc::new(Mutex::new(host));
    let worker_ready = ready.clone();
    let worker_window = last_window.clone();
    let worker_host = host.clone();
    let handle = app.clone();
    app.manage(crate::update_windows::Restores::default());
    let server = listener.serve(move |request| {
        let request_id = request.id;
        let command: WorkerCommand = serde_json::from_value(request.payload)
            .map_err(|_| "invalid worker request".to_string())?;
        match command {
            #[cfg(any(debug_assertions, feature = "e2e-data-dir"))]
            WorkerCommand::TestWindowFocus { launch_id } => {
                if launch_id != registration.launch_id
                    || handle.state::<crate::environment::Environment>().kind
                        != crate::environment::Kind::Test
                {
                    return Err("test focus observation unavailable".into());
                }
                let windows: BTreeMap<_, _> = handle
                    .webview_windows()
                    .into_iter()
                    .map(|(label, window)| window.is_focused().map(|focused| (label, focused)))
                    .collect::<Result<_, _>>()
                    .map_err(|error| error.to_string())?;
                Ok(json!(windows))
            }
            WorkerCommand::SnapshotWindows { launch_id } => {
                if launch_id != registration.launch_id || !worker_ready.load(Ordering::Acquire) {
                    return Err("worker identity mismatch".into());
                }
                crate::update_windows::snapshot(&handle)
                    .and_then(|windows| serde_json::to_value(windows).map_err(|_| invalid()))
                    .map_err(|error| error.to_string())
            }
            WorkerCommand::RestoreWindows { launch_id, vault } => {
                if launch_id != registration.launch_id
                    || !worker_ready.load(Ordering::Acquire)
                    || vault.id != registration.vault_id
                    || vault.directory != registration.directory
                {
                    return Err("worker identity mismatch".into());
                }
                crate::update_windows::begin(&handle, request_id, vault)
                    .map_err(|error| error.to_string())?;
                Ok(json!({"accepted":true}))
            }
            WorkerCommand::RestoreStatus {
                launch_id,
                operation_id,
            } => {
                if launch_id != registration.launch_id {
                    return Err("worker identity mismatch".into());
                }
                crate::update_windows::progress(&handle, operation_id)
                    .and_then(|progress| serde_json::to_value(progress).map_err(|_| invalid()))
                    .map_err(|error| error.to_string())
            }
            WorkerCommand::UpdateProgress {
                launch_id,
                progress,
            } => {
                if launch_id != registration.launch_id {
                    return Err("worker identity mismatch".into());
                }
                handle
                    .emit("coordinator-update-progress", progress)
                    .map_err(|error| error.to_string())?;
                Ok(json!({"accepted":true}))
            }
            WorkerCommand::Tray { launch_id, action } => {
                if launch_id != registration.launch_id || !worker_ready.load(Ordering::Acquire) {
                    return Err("tray destination identity or readiness changed".into());
                }
                crate::shortcut_actions::execute_tray(&handle, request_id, action)
            }
            WorkerCommand::InviteLink { launch_id, link } => {
                if launch_id != registration.launch_id || !worker_ready.load(Ordering::Acquire) {
                    return Err("invite link destination identity or readiness changed".into());
                }
                if !crate::deep_links::is_invite_link(&link) {
                    return Err("not an invite link".into());
                }
                crate::deep_links::hand_over(&handle, link);
                let app = handle.clone();
                handle
                    .run_on_main_thread(move || crate::tray::focus_main_window(&app))
                    .map_err(|_| "worker activation unavailable".to_string())?;
                Ok(json!({"accepted":true}))
            }
            WorkerCommand::CaptureFailed { launch_id, message } => {
                if launch_id != registration.launch_id {
                    return Err("worker identity mismatch".into());
                }
                handle
                    .emit(
                        crate::app_events::AppEvent::CaptureFailed.as_str(),
                        json!({"message":message}),
                    )
                    .map_err(|_| "capture failure notification unavailable".to_string())?;
                Ok(json!({"accepted":true}))
            }
            WorkerCommand::Shortcut {
                launch_id,
                command_id,
                accelerator,
            } => {
                if launch_id != registration.launch_id || !worker_ready.load(Ordering::Acquire) {
                    return Err("shortcut destination identity or readiness changed".into());
                }
                crate::shortcut_actions::execute(&handle, request_id, command_id, accelerator)
            }
            WorkerCommand::Activate { window } => {
                let label = window.unwrap_or_else(|| "main".into());
                if !valid_window(&label) {
                    return Err("invalid worker window".into());
                }
                let app = handle.clone();
                handle
                    .run_on_main_thread(move || {
                        let target = app
                            .get_webview_window(&label)
                            .or_else(|| app.get_webview_window("main"));
                        if let Some(window) = target {
                            crate::tray::focus_vault_window(&app, &window);
                        }
                    })
                    .map_err(|_| "worker activation unavailable".to_string())?;
                Ok(json!({"accepted":true}))
            }
            WorkerCommand::Identify { launch_id } => {
                if launch_id != registration.launch_id {
                    return Err("worker identity mismatch".into());
                }
                let mut identity = registration.identity(worker_ready.load(Ordering::Acquire));
                identity.window = worker_window
                    .lock()
                    .map_err(|_| "worker window unavailable".to_string())?
                    .clone();
                serde_json::to_value(identity).map_err(|_| "worker identity unavailable".into())
            }
            WorkerCommand::Adopt {
                launch_id,
                host,
                contract,
            } => {
                let adopted = (|| -> AppResult<Value> {
                    if &contract != crate::worker_registration::RuntimeContract::current() {
                        return Err(invalid());
                    }
                    adopt_host(&registration, &worker_host, launch_id, host)?;
                    let mut identity = registration.identity(worker_ready.load(Ordering::Acquire));
                    identity.window = worker_window.lock().map_err(|_| invalid())?.clone();
                    serde_json::to_value(identity).map_err(|_| invalid())
                })();
                adopted.map_err(|_| "worker adoption unavailable; ownership retained".into())
            }
            #[cfg(any(debug_assertions, feature = "e2e-data-dir"))]
            WorkerCommand::TestCloseFailure { launch_id } => {
                if launch_id != registration.launch_id {
                    return Err("worker identity mismatch".into());
                }
                crate::worker_shutdown::test_close_failure(&handle)
                    .map_err(|error| error.to_string())?;
                Ok(json!({"accepted":true}))
            }
            #[cfg(any(debug_assertions, feature = "e2e-data-dir"))]
            WorkerCommand::TestHoldJob { launch_id, seconds } => {
                if launch_id != registration.launch_id
                    || seconds > 60
                    || handle.state::<crate::environment::Environment>().kind
                        != crate::environment::Kind::Test
                {
                    return Err("test service job unavailable".into());
                }
                let job = handle
                    .state::<crate::vault_jobs::Jobs>()
                    .enter()
                    .map_err(|error| error.to_string())?;
                std::thread::Builder::new()
                    .name("test-vault-job".into())
                    .spawn(move || {
                        let _job = job;
                        std::thread::sleep(Duration::from_secs(seconds));
                    })
                    .map_err(|error| error.to_string())?;
                Ok(json!({"accepted":true}))
            }
            WorkerCommand::Close { launch_id } => {
                if launch_id != registration.launch_id {
                    return Err("worker identity mismatch".into());
                }
                crate::worker_shutdown::queue_close(&handle, request_id)
                    .map_err(|_| "worker close unavailable".to_string())?;
                Ok(json!({"accepted":true}))
            }
            WorkerCommand::QuitFailed { launch_id, message } => {
                if launch_id != registration.launch_id {
                    return Err("worker identity mismatch".into());
                }
                handle
                    .emit(
                        crate::app_events::AppEvent::EnvironmentQuitFailed.as_str(),
                        json!({"message":message}),
                    )
                    .map_err(|_| "quit failure notification unavailable".to_string())?;
                Ok(json!({"accepted":true}))
            }
            WorkerCommand::CloseStatus {
                launch_id,
                operation_id,
            } => {
                if launch_id != registration.launch_id {
                    return Err("worker identity mismatch".into());
                }
                let progress = crate::worker_shutdown::close_progress(&handle, operation_id)
                    .map_err(|error| error.to_string())?;
                serde_json::to_value(progress).map_err(|_| "worker close status unavailable".into())
            }
            WorkerCommand::CancelClose {
                launch_id,
                operation_id,
            } => {
                if launch_id != registration.launch_id {
                    return Err("worker identity mismatch".into());
                }
                crate::worker_shutdown::cancel_close(&handle, operation_id)
                    .map_err(|error| error.to_string())?;
                Ok(json!({"cancelled":true}))
            }
            WorkerCommand::RefreshDeviceSettings { launch_id } => {
                if launch_id != registration.launch_id || !worker_ready.load(Ordering::Acquire) {
                    return Err("worker settings refresh unavailable".into());
                }
                handle
                    .emit(crate::app_events::AppEvent::UiSettingsChanged.as_str(), ())
                    .map_err(|_| "worker settings notification unavailable".to_string())?;
                let _ = handle.emit(crate::app_events::AppEvent::PluginsChanged.as_str(), ());
                let app = handle.clone();
                handle
                    .run_on_main_thread(move || {
                        if let Err(err) = crate::desktop_settings::refresh_runtime(&app) {
                            log::warn!("[vaults] desktop settings refresh failed: {err}");
                        }
                    })
                    .map_err(|_| "worker desktop settings refresh unavailable".to_string())?;
                Ok(json!({"accepted":true}))
            }
        }
    })?;
    host.lock()
        .map_err(|_| invalid())?
        .clone()
        .retry_call(&request(&HostCommand::Register {
            vault_id: vault_id.clone(),
            launch_id: *launch_id,
            endpoint,
            contract: RuntimeContract::current().clone(),
        })?)?
        .map_err(AppError::InvalidArg)?;
    app.manage(crate::worker_shutdown::Shutdown::default());
    app.manage(Worker {
        vault_id: vault_id.clone(),
        launch_id: *launch_id,
        host,
        ready,
        last_window,
        _server: server,
    });
    crate::coordinator_revival::start(app)?;
    start_startup_watchdog(app)?;
    Ok(())
}

/// The main window stays hidden until readiness. A frontend that neither
/// becomes ready nor reports failure must not keep the vault leased forever.
fn start_startup_watchdog(app: &AppHandle) -> AppResult<()> {
    let app = app.clone();
    std::thread::Builder::new()
        .name("vault-startup-watchdog".into())
        .spawn(move || {
            std::thread::sleep(STARTUP_LIMIT);
            loop {
                match fail_startup(&app, "the vault window did not finish starting") {
                    Ok(()) => return,
                    // Startup work is still writing. Never interrupt it.
                    Err(error) => log::warn!("[vaults] unready worker retained: {error}"),
                }
                std::thread::sleep(Duration::from_secs(30));
            }
        })?;
    Ok(())
}

/// Exit a worker whose frontend never became ready. No editor has loaded, so
/// only startup services can hold unsaved work; both gates drain first.
fn fail_startup(app: &AppHandle, message: &str) -> AppResult<()> {
    let worker = app.state::<Worker>();
    if worker.ready.load(Ordering::Acquire) {
        return Ok(());
    }
    let jobs = app.state::<crate::vault_jobs::Jobs>().pause()?;
    let saves = app.state::<crate::vault_jobs::Saves>().pause()?;
    let timeout = Duration::from_secs(30);
    jobs.wait(timeout)?;
    saves.wait(timeout)?;
    // Readiness needs a save job, so it cannot begin after this check.
    if worker.ready.load(Ordering::Acquire) {
        return Ok(());
    }
    crate::vault_jobs::Pause::commit_all(vec![jobs, saves])?;
    let mut message: String = message.chars().filter(|c| !c.is_control()).collect();
    if message.is_empty() {
        message = "the vault window could not start".into();
    }
    while message.len() > STARTUP_FAILURE_MAX {
        message.pop();
    }
    log::error!("[vaults] worker startup failed; releasing the vault: {message}");
    let host = worker.host.lock().map_err(|_| invalid())?.clone();
    let notice = request(&HostCommand::StartupFailed {
        vault_id: worker.vault_id.clone(),
        launch_id: worker.launch_id,
        message,
    })?;
    // The released lease is the authority. A lost notice only costs the host
    // its specific message.
    if !matches!(host.retry_call(&notice), Ok(Ok(_))) {
        log::warn!("[vaults] startup failure notification unavailable");
    }
    app.exit(1);
    Ok(())
}

/// The frontend gave up initializing this vault after its own retries.
#[tauri::command]
pub async fn vault_worker_failed(
    app: AppHandle,
    window: WebviewWindow,
    message: String,
) -> CommandResult<()> {
    if window.label() != "main" || app.try_state::<Worker>().is_none() {
        return Ok(());
    }
    Ok(
        tauri::async_runtime::spawn_blocking(move || fail_startup(&app, &message))
            .await
            .map_err(|_| invalid())??,
    )
}

#[tauri::command]
pub async fn vault_worker_ready(app: AppHandle, window: WebviewWindow) -> CommandResult<()> {
    if window.label() != "main" {
        return Ok(());
    }
    let Some(worker) = app.try_state::<Worker>() else {
        return Ok(());
    };
    // An abandoned startup stops admission before it exits; see fail_startup.
    let _startup = app.state::<crate::vault_jobs::Saves>().enter()?;
    worker.ready.store(true, Ordering::Release);
    let request = request(&HostCommand::Ready {
        vault_id: worker.vault_id.clone(),
        launch_id: worker.launch_id,
    })?;
    let host = worker.host.lock().map_err(|_| invalid())?.clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.retry_call(&request)?
            .map(|_| ())
            .map_err(AppError::InvalidArg)
    })
    .await
    .map_err(|_| invalid())??;
    // A peer may have saved after this worker's initial snapshot but before
    // host registration marked it ready for invalidations.
    if app
        .emit(crate::app_events::AppEvent::UiSettingsChanged.as_str(), ())
        .is_err()
    {
        log::warn!("[vaults] readiness settings refresh unavailable");
    }
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(err) = crate::desktop_settings::refresh_runtime(&handle) {
            log::warn!("[vaults] readiness desktop settings refresh failed: {err}");
        }
    })?;
    Ok(())
}

#[tauri::command]
pub async fn open_profile_window(
    app: AppHandle,
    id: String,
    in_this_window: Option<bool>,
) -> CommandResult<()> {
    let worker = app.try_state::<Worker>().ok_or_else(invalid)?;
    let replace = in_this_window.unwrap_or(false);
    if replace && !crate::worker_shutdown::coordinator_revival_allowed(&app) {
        return Err(invalid().into());
    }
    // A handoff must be able to close its requesting worker. Admission is
    // checked above, but its IPC waiter cannot hold a job through that close.
    let job = if replace {
        None
    } else {
        Some(app.state::<crate::vault_jobs::Jobs>().enter()?)
    };
    let command = if replace {
        HostCommand::HandoffFromWindow {
            source_vault_id: worker.vault_id.clone(),
            launch_id: worker.launch_id,
            vault_id: id,
        }
    } else {
        HostCommand::OpenFromWindow {
            source_vault_id: worker.vault_id.clone(),
            launch_id: worker.launch_id,
            vault_id: id,
        }
    };
    let request = request(&command)?;
    let host = worker.host.lock().map_err(|_| invalid())?.clone();
    let probe = self::request(&HostCommand::Status)?;
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let _job = job;
        crate::foreground::after_probe(&host, &probe)?;
        host.retry_call(&request)?
            .map(|_| ())
            .map_err(AppError::InvalidArg)?;
        await_open_result(
            &host,
            request.id,
            Instant::now() + OPEN_TIMEOUT + Duration::from_secs(if replace { 180 } else { 10 }),
        )
    })
    .await
    .map_err(|_| invalid())??)
}

pub(crate) fn autostart_setting(app: &AppHandle, enabled: Option<bool>) -> AppResult<bool> {
    let worker = app.state::<Worker>();
    let host = worker.host.lock().map_err(|_| invalid())?.clone();
    let request = request(&HostCommand::Autostart {
        vault_id: worker.vault_id.clone(),
        launch_id: worker.launch_id,
        enabled,
    })?;
    host.retry_call(&request)?.map_err(AppError::InvalidArg)?;
    let poll = self::request(&HostCommand::AutostartStatus {
        operation_id: request.id,
    })?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let progress = host.retry_call(&poll)?.map_err(AppError::InvalidArg)?;
        match serde_json::from_value::<AutostartProgress>(progress).map_err(|_| invalid())? {
            AutostartProgress::Ready { enabled } => return Ok(enabled),
            AutostartProgress::Failed { message } => return Err(AppError::InvalidArg(message)),
            AutostartProgress::Pending => {}
        }
        if Instant::now() >= deadline {
            return Err(AppError::InvalidArg(
                "startup registration result is unavailable; reload the setting".into(),
            ));
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

pub(crate) fn window_state(app: &AppHandle) -> AppResult<crate::vault_window_state::View> {
    let worker = app.state::<Worker>();
    let host = worker.host.lock().map_err(|_| invalid())?.clone();
    let reply = host
        .retry_call(&request(&HostCommand::WindowState {
            vault_id: worker.vault_id.clone(),
            launch_id: worker.launch_id,
        })?)?
        .map_err(AppError::InvalidArg)?;
    serde_json::from_value(reply).map_err(|_| invalid())
}

pub(crate) fn check_update(
    app: &AppHandle,
    force: bool,
) -> AppResult<Option<crate::coordinator_updater::Available>> {
    let worker = app.state::<Worker>();
    let host = worker.host.lock().map_err(|_| invalid())?.clone();
    let check = request(&HostCommand::UpdateCheck {
        vault_id: worker.vault_id.clone(),
        launch_id: worker.launch_id,
        force,
    })?;
    host.retry_call(&check)?.map_err(AppError::InvalidArg)?;
    let poll = request(&HostCommand::UpdateCheckStatus {
        operation_id: check.id,
    })?;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let reply = host.retry_call(&poll)?.map_err(AppError::InvalidArg)?;
        match serde_json::from_value::<crate::coordinator_updater::CheckProgress>(reply)
            .map_err(|_| invalid())?
        {
            crate::coordinator_updater::CheckProgress::Ready { available } => return Ok(available),
            crate::coordinator_updater::CheckProgress::Failed { message } => {
                return Err(AppError::InvalidArg(message))
            }
            crate::coordinator_updater::CheckProgress::Pending => {}
        }
        if Instant::now() >= deadline {
            return Err(invalid());
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

pub(crate) fn install_update(app: &AppHandle, update_id: Uuid) -> AppResult<()> {
    let worker = app.state::<Worker>();
    let host = worker.host.lock().map_err(|_| invalid())?.clone();
    let install = request(&HostCommand::UpdateInstall {
        vault_id: worker.vault_id.clone(),
        launch_id: worker.launch_id,
        update_id,
    })?;
    host.retry_call(&install)?.map_err(AppError::InvalidArg)?;
    await_open_result(&host, install.id, Instant::now() + Duration::from_secs(600))
}

fn await_open_result(host: &Endpoint, operation_id: Uuid, deadline: Instant) -> AppResult<()> {
    let poll = request(&HostCommand::OpenStatus { operation_id })?;
    loop {
        let reply = host.retry_call(&poll)?.map_err(AppError::InvalidArg)?;
        match serde_json::from_value::<OpenProgress>(reply).map_err(|_| invalid())? {
            OpenProgress::Ready => return Ok(()),
            OpenProgress::Failed { message } => return Err(AppError::InvalidArg(message)),
            OpenProgress::Pending => {}
        }
        if Instant::now() >= deadline {
            return Err(AppError::InvalidArg(
                "vault opening result is unavailable; source remains open".into(),
            ));
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_open_authenticates_source_replays_result_and_never_closes_it() {
        let root = std::env::temp_dir().join(format!("ms-menu-open-{}", Uuid::new_v4()));
        let owner = crate::storage_locks::VaultLock::acquire(&root).unwrap();
        let listener = ipc::Coordinator::for_worker(&owner).unwrap();
        let instance = Uuid::new_v4();
        let launch_id = Uuid::new_v4();
        let mut book = Book {
            exported: true,
            ..Book::default()
        };
        let mut source = pending(launch_id);
        source.endpoint = Some(listener.endpoint().clone());
        book.workers.insert("source".into(), source);
        let menu_request = |source: &str, launch_id, target: &str| {
            request(&HostCommand::OpenFromWindow {
                source_vault_id: source.into(),
                launch_id,
                vault_id: target.into(),
            })
            .unwrap()
        };
        assert!(book
            .accept(instance, menu_request("source", launch_id, "target"))
            .is_err());
        book.workers.get_mut("source").unwrap().ready = true;
        assert!(book
            .accept(instance, menu_request("missing", launch_id, "target"))
            .is_err());
        assert!(book
            .accept(instance, menu_request("source", Uuid::new_v4(), "target"))
            .is_err());
        assert!(book
            .accept(instance, menu_request("source", launch_id, "../target"))
            .is_err());
        book.workers.get_mut("source").unwrap().error = Some("unavailable".into());
        assert!(book
            .accept(instance, menu_request("source", launch_id, "target"))
            .is_err());
        book.workers.get_mut("source").unwrap().error = None;

        let opening = menu_request("source", launch_id, "target");
        assert!(matches!(book.accept(instance, opening.clone()).unwrap().1,
            Some(Action::Open(id)) if id == "target"));
        assert!(book.accept(instance, opening.clone()).unwrap().1.is_none());
        assert!(matches!(
            book.open_status(opening.id).unwrap(),
            OpenProgress::Pending
        ));
        book.complete_open(
            opening.id,
            Err(AppError::InvalidArg("target missing".into())),
        );
        book.complete_open(opening.id, Ok(()));
        assert!(
            matches!(book.open_status(opening.id).unwrap(), OpenProgress::Failed { message } if message.contains("target missing"))
        );
        assert!(book.accept(instance, opening).unwrap().1.is_none());
        assert_eq!(book.workers["source"].id, launch_id);
        assert!(book.workers["source"].ready);
        assert!(book.quitting.is_none());
        book.quitting = Some(Uuid::new_v4());
        assert!(book
            .accept(instance, menu_request("source", launch_id, "target"))
            .is_err());
        drop(listener);
        drop(owner);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn window_state_requires_ready_caller_and_retains_starting_and_unavailable_owners() {
        use crate::vault_window_state::Status;
        let root = std::env::temp_dir().join(format!("ms-window-state-{}", Uuid::new_v4()));
        let owner = crate::storage_locks::VaultLock::acquire(&root).unwrap();
        let listener = ipc::Coordinator::for_worker(&owner).unwrap();
        let id = Uuid::new_v4();
        let mut book = Book {
            exported: true,
            ..Book::default()
        };
        let mut source = pending(id);
        source.endpoint = Some(listener.endpoint().clone());
        book.workers.insert("source".into(), source);
        assert!(book.window_state("source", id).is_err());
        book.workers.get_mut("source").unwrap().ready = true;
        book.workers
            .insert("starting".into(), pending(Uuid::new_v4()));
        let mut unknown = pending(Uuid::new_v4());
        unknown.error = Some("owner is unresponsive; ownership retained".into());
        book.workers.insert("unknown".into(), unknown);
        let view = book.window_state("source", id).unwrap();
        assert!(view.supervised);
        assert_eq!(
            view.vaults
                .iter()
                .map(|entry| (&*entry.vault_id, entry.status.clone()))
                .collect::<Vec<_>>(),
            [
                ("source", Status::Ready),
                ("starting", Status::Starting),
                ("unknown", Status::Unavailable)
            ]
        );
        assert!(book.window_state("source", Uuid::new_v4()).is_err());
        assert!(book.window_state("closed", id).is_err());
        assert!(!view.vaults.iter().any(|entry| entry.vault_id == "closed"));
        book.quitting = Some(Uuid::new_v4());
        assert!(
            book.window_state("source", id).is_ok(),
            "read-only observation stays available during quit"
        );
        drop(listener);
        drop(owner);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn updater_requires_ready_owner_deduplicates_and_fences_quit_and_new_actions() {
        let root = std::env::temp_dir().join(format!("ms-update-book-{}", Uuid::new_v4()));
        let owner = crate::storage_locks::VaultLock::acquire(&root).unwrap();
        let listener = ipc::Coordinator::for_worker(&owner).unwrap();
        let instance = Uuid::new_v4();
        let launch_id = Uuid::new_v4();
        let mut book = Book {
            exported: true,
            ..Book::default()
        };
        let mut launch = pending(launch_id);
        launch.endpoint = Some(listener.endpoint().clone());
        book.workers.insert("a".into(), launch);
        let check = request(&HostCommand::UpdateCheck {
            vault_id: "a".into(),
            launch_id,
            force: false,
        })
        .unwrap();
        assert!(book.accept(instance, check.clone()).is_err());
        book.workers.get_mut("a").unwrap().ready = true;
        assert!(matches!(
            book.accept(instance, check.clone()).unwrap().1,
            Some(Action::UpdateCheck(false))
        ));
        assert!(book.accept(instance, check.clone()).unwrap().1.is_none());
        let status = request(&HostCommand::UpdateCheckStatus {
            operation_id: check.id,
        })
        .unwrap();
        assert_eq!(
            book.accept(instance, status.clone()).unwrap().0,
            json!({"state":"pending"})
        );
        book.operations.get_mut(&check.id).unwrap().update_result =
            Some(crate::coordinator_updater::CheckProgress::Ready { available: None });
        assert_eq!(
            book.accept(instance, status.clone()).unwrap().0,
            json!({"state":"ready", "available":null})
        );
        assert!(book.open_status(check.id).is_err());
        let update_id = Uuid::new_v4();
        let install = request(&HostCommand::UpdateInstall {
            vault_id: "a".into(),
            launch_id,
            update_id,
        })
        .unwrap();
        book.recovering = true;
        assert!(book.accept(instance, install.clone()).is_err());
        book.recovering = false;
        assert!(
            matches!(book.accept(instance, install.clone()).unwrap().1, Some(Action::UpdateInstall(id)) if id == update_id)
        );
        assert!(book.accept(instance, install.clone()).unwrap().1.is_none());
        assert!(book
            .accept(instance, request(&HostCommand::Quit).unwrap())
            .is_err());
        assert!(book
            .accept(instance, request(&HostCommand::Activate).unwrap())
            .is_err());
        assert!(book
            .accept(
                instance,
                request(&HostCommand::UpdateCheck {
                    vault_id: "a".into(),
                    launch_id,
                    force: true
                })
                .unwrap()
            )
            .is_err());
        assert!(
            book.accept(instance, status).is_ok(),
            "previous check remains readable during installation"
        );
        assert_eq!(book.open_status(install.id).unwrap(), OpenProgress::Pending);
        book.complete_open(
            install.id,
            Err(AppError::InvalidArg("signature mismatch".into())),
        );
        assert!(matches!(
            book.open_status(install.id).unwrap(),
            OpenProgress::Failed { .. }
        ));
        book.quitting = None;
        assert!(
            book.accept(instance, install).unwrap().1.is_none(),
            "failed installation is never rerun on a retry"
        );
        assert!(book
            .accept(instance, request(&HostCommand::Activate).unwrap())
            .is_ok());
        drop(listener);
        drop(owner);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn autostart_requires_ready_owner_and_replays_terminal_result_without_mutation() {
        let root = std::env::temp_dir().join(format!("ms-autostart-book-{}", Uuid::new_v4()));
        let owner = crate::storage_locks::VaultLock::acquire(&root).unwrap();
        let listener = ipc::Coordinator::for_worker(&owner).unwrap();
        let instance = Uuid::new_v4();
        let launch_id = Uuid::new_v4();
        let mut book = Book {
            exported: true,
            ..Book::default()
        };
        let mut launch = pending(launch_id);
        launch.endpoint = Some(listener.endpoint().clone());
        book.workers.insert("a".into(), launch);
        let get = request(&HostCommand::Autostart {
            vault_id: "a".into(),
            launch_id,
            enabled: None,
        })
        .unwrap();
        assert!(book.accept(instance, get.clone()).is_err());
        book.workers.get_mut("a").unwrap().ready = true;
        assert!(matches!(
            book.accept(instance, get.clone()).unwrap().1,
            Some(Action::Autostart(None))
        ));
        assert_eq!(
            book.autostart_status(get.id).unwrap(),
            AutostartProgress::Pending
        );
        book.complete_autostart(get.id, Ok(false));
        book.complete_autostart(get.id, Ok(true));
        assert_eq!(
            book.autostart_status(get.id).unwrap(),
            AutostartProgress::Ready { enabled: false }
        );
        assert!(book.accept(instance, get.clone()).unwrap().1.is_none());
        assert!(book
            .accept(
                instance,
                Request {
                    id: get.id,
                    payload: request(&HostCommand::Open {
                        vault_id: "a".into()
                    })
                    .unwrap()
                    .payload
                }
            )
            .is_err());
        assert!(book.open_status(get.id).is_err());
        assert!(book.autostart_status(Uuid::new_v4()).is_err());
        let set = request(&HostCommand::Autostart {
            vault_id: "a".into(),
            launch_id,
            enabled: Some(true),
        })
        .unwrap();
        assert!(matches!(
            book.accept(instance, set.clone()).unwrap().1,
            Some(Action::Autostart(Some(true)))
        ));
        book.complete_autostart(
            set.id,
            Err(AppError::InvalidArg("OS rejected registration".into())),
        );
        assert!(matches!(
            book.autostart_status(set.id).unwrap(),
            AutostartProgress::Failed { .. }
        ));
        assert!(book.accept(instance, set).unwrap().1.is_none());
        book.accept(instance, request(&HostCommand::Quit).unwrap())
            .unwrap();
        assert!(book
            .accept(
                instance,
                request(&HostCommand::Autostart {
                    vault_id: "a".into(),
                    launch_id,
                    enabled: Some(false)
                })
                .unwrap()
            )
            .is_err());
        drop(listener);
        drop(owner);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn idle_exit_waits_for_ready_session_and_every_accepted_launch_job() {
        let jobs = crate::vault_jobs::Jobs::default();
        let mut book = Book {
            exported: true,
            ..Book::default()
        };
        assert!(
            !book.idle_exit_candidate(&jobs),
            "failed startup must remain inspectable"
        );
        book.had_ready_worker = true;
        assert!(book.idle_exit_candidate(&jobs));
        let instance = Uuid::new_v4();
        let (_, action) = book
            .accept(
                instance,
                request(&HostCommand::Open {
                    vault_id: "a".into(),
                })
                .unwrap(),
            )
            .unwrap();
        assert!(matches!(action, Some(Action::Open(_))));
        let job = jobs.enter().unwrap();
        assert!(
            !book.idle_exit_candidate(&jobs),
            "accepted launch owns admission before reservation"
        );
        drop(job);
        assert!(book.idle_exit_candidate(&jobs));
        book.accept(instance, request(&HostCommand::Quit).unwrap())
            .unwrap();
        assert!(!book.idle_exit_candidate(&jobs));
        assert!(book
            .accept(instance, request(&HostCommand::Activate).unwrap())
            .is_err());
    }

    #[test]
    fn tray_targets_overall_recent_vault_and_never_falls_back_on_failure() {
        let index = crate::profiles::Index {
            active: "capture".into(),
            profiles: ["capture", "other"]
                .into_iter()
                .map(|id| crate::profiles::Profile {
                    id: id.into(),
                    name: id.into(),
                    created_at: String::new(),
                    color: None,
                })
                .collect(),
        };
        let mut book = Book {
            exported: true,
            ..Book::default()
        };
        assert_eq!(tray_destination(&book, &index).unwrap(), "capture");
        book.last = Some("other".into());
        assert_eq!(tray_destination(&book, &index).unwrap(), "other");
        book.last = Some("missing".into());
        assert!(tray_destination(&book, &index).is_err());
        book.last = None;
        book.shortcut_order = vec!["capture".into(), "other".into()];
        assert_eq!(tray_destination(&book, &index).unwrap(), "other");
        book.quitting = Some(Uuid::new_v4());
        assert!(tray_destination(&book, &index).is_err());
    }

    #[test]
    fn tray_replays_and_quit_fences_capture_without_redispatch() {
        let mut book = Book {
            exported: true,
            ..Book::default()
        };
        let instance = Uuid::new_v4();
        let tray = request(&HostCommand::Tray {
            action: crate::shortcut_actions::TrayCommand::Diagram,
        })
        .unwrap();
        assert!(matches!(
            book.accept(instance, tray.clone()).unwrap().1,
            Some(Action::Tray(crate::shortcut_actions::TrayCommand::Diagram))
        ));
        assert!(book.accept(instance, tray.clone()).unwrap().1.is_none());
        book.complete_open(tray.id, Ok(()));
        assert_eq!(book.open_status(tray.id).unwrap(), OpenProgress::Ready);
        book.accept(instance, request(&HostCommand::Quit).unwrap())
            .unwrap();
        assert!(book
            .accept(
                instance,
                request(&HostCommand::Tray {
                    action: crate::shortcut_actions::TrayCommand::Drawing
                })
                .unwrap()
            )
            .is_err());
        assert!(book.accept(instance, tray).unwrap().1.is_none());
    }

    #[test]
    fn quit_is_one_retryable_intent_and_fences_new_actions_until_failure() {
        let mut book = Book {
            exported: true,
            ..Book::default()
        };
        let instance = Uuid::new_v4();
        let quit = request(&HostCommand::Quit).unwrap();
        let (reply, action) = book.accept(instance, quit.clone()).unwrap();
        assert!(matches!(action, Some(Action::Quit)));
        assert_eq!(reply["operation_id"], quit.id.to_string());
        assert_eq!(book.open_status(quit.id).unwrap(), OpenProgress::Pending);
        assert!(book.accept(instance, quit.clone()).unwrap().1.is_none());
        let alias = request(&HostCommand::Quit).unwrap();
        let retry = book.accept(instance, alias.clone()).unwrap();
        assert_eq!(retry.0, reply);
        assert!(retry.1.is_none());
        for command in [
            HostCommand::Activate,
            HostCommand::Open {
                vault_id: "capture".into(),
            },
            HostCommand::Shortcut {
                command_id: crate::hotkeys::GlobalShortcutCommandId::NewDrawing,
                accelerator: None,
            },
        ] {
            assert!(book.accept(instance, request(&command).unwrap()).is_err());
        }
        assert!(book
            .accept(instance, request(&HostCommand::Status).unwrap())
            .is_ok());
        book.complete_open(quit.id, Err(AppError::InvalidArg("save cancelled".into())));
        book.quitting = None;
        assert!(matches!(
            book.open_status(quit.id).unwrap(),
            OpenProgress::Failed { .. }
        ));
        assert!(book.accept(instance, quit).unwrap().1.is_none());
        assert!(book.accept(instance, alias.clone()).unwrap().1.is_none());
        assert!(matches!(
            book.open_status(alias.id).unwrap(),
            OpenProgress::Failed { .. }
        ));
        assert!(matches!(
            book.accept(instance, request(&HostCommand::Quit).unwrap())
                .unwrap()
                .1,
            Some(Action::Quit)
        ));
    }

    #[test]
    fn quit_owner_waits_for_child_exit_and_the_physical_lease() {
        use crate::coordinator_shutdown::Owner;
        let root = std::env::temp_dir().join(format!("ms-quit-owner-{}", Uuid::new_v4()));
        let directory = crate::profiles::profile_dir(&root, "capture");
        std::fs::create_dir_all(&directory).unwrap();
        let launch_id = Uuid::new_v4();
        let book = Mutex::new(Book::default());
        book.lock().unwrap().workers.insert(
            "capture".into(),
            Launch {
                id: launch_id,
                endpoint: None,
                ready: false,
                activate_on_ready: false,
                error: None,
                adopted: false,
                focused_window: None,
            },
        );
        // Before the child starts there is no OS lease, but the reservation is live.
        assert_eq!(
            close_owner(&book, &root, "capture", launch_id).unwrap(),
            Owner::Present
        );
        let owner = crate::storage_locks::VaultLock::acquire(&directory).unwrap();
        book.lock().unwrap().remove_launch("capture", launch_id);
        assert_eq!(
            close_owner(&book, &root, "capture", launch_id).unwrap(),
            Owner::Changed
        );
        drop(owner);
        assert_eq!(
            close_owner(&book, &root, "capture", launch_id).unwrap(),
            Owner::Released
        );
        book.lock().unwrap().workers.insert(
            "capture".into(),
            Launch {
                id: launch_id,
                endpoint: None,
                ready: false,
                activate_on_ready: false,
                error: None,
                adopted: true,
                focused_window: None,
            },
        );
        let owner = crate::storage_locks::VaultLock::acquire(&directory).unwrap();
        assert_eq!(
            close_owner(&book, &root, "capture", launch_id).unwrap(),
            Owner::Present
        );
        drop(owner);
        assert_eq!(
            close_owner(&book, &root, "capture", launch_id).unwrap(),
            Owner::Released
        );
        assert!(book.lock().unwrap().workers.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn shortcut_requests_replay_without_redispatch_and_keep_terminal_failure() {
        let mut book = Book {
            exported: true,
            ..Book::default()
        };
        let instance = Uuid::new_v4();
        let request = request(&HostCommand::Shortcut {
            command_id: crate::hotkeys::GlobalShortcutCommandId::NewDrawing,
            accelerator: None,
        })
        .unwrap();
        assert!(matches!(
            book.accept(instance, request.clone()).unwrap().1,
            Some(Action::Shortcut(
                crate::hotkeys::GlobalShortcutCommandId::NewDrawing,
                None
            ))
        ));
        assert!(book.accept(instance, request.clone()).unwrap().1.is_none());
        book.complete_open(
            request.id,
            Err(AppError::InvalidArg("capture vault is disabled".into())),
        );
        assert!(
            matches!(book.open_status(request.id).unwrap(), OpenProgress::Failed { message } if message.contains("disabled"))
        );
        let mut changed = request.clone();
        changed.payload["command_id"] = json!("newInkNote");
        assert!(book.accept(instance, changed).is_err());
        assert!(book.accept(instance, request).unwrap().1.is_none());
    }

    #[test]
    fn open_results_are_repeatable_and_status_polls_do_not_consume_replay_capacity() {
        let instance = Uuid::new_v4();
        let mut book = Book {
            exported: true,
            ..Book::default()
        };
        let open = request(&HostCommand::Open {
            vault_id: "a".into(),
        })
        .unwrap();
        let (ack, action) = book.accept(instance, open.clone()).unwrap();
        assert!(matches!(action, Some(Action::Open(id)) if id == "a"));
        let poll = request(&HostCommand::OpenStatus {
            operation_id: open.id,
        })
        .unwrap();
        for _ in 0..1100 {
            assert_eq!(
                book.accept(instance, poll.clone()).unwrap().0,
                json!({"state":"pending"})
            );
        }
        assert_eq!(book.operations.len(), 1);
        assert!(book.accept(instance, open.clone()).unwrap().1.is_none());
        book.complete_open(open.id, Err(AppError::NotFound("target missing".into())));
        book.complete_open(open.id, Ok(()));
        assert!(
            matches!(book.open_status(open.id).unwrap(), OpenProgress::Failed { message } if message.contains("target missing"))
        );
        assert_eq!(book.accept(instance, open).unwrap().0, ack);
        assert_eq!(book.accept(instance, poll).unwrap().0["state"], "failed");
        assert!(book.open_status(Uuid::new_v4()).is_err());
        let activate = request(&HostCommand::Activate).unwrap();
        book.accept(instance, activate.clone()).unwrap();
        assert!(book.open_status(activate.id).is_err());
        let success = request(&HostCommand::Open {
            vault_id: "b".into(),
        })
        .unwrap();
        book.accept(instance, success.clone()).unwrap();
        book.complete_open(success.id, Ok(()));
        book.complete_open(success.id, Err(invalid()));
        assert_eq!(book.open_status(success.id).unwrap(), OpenProgress::Ready);
        book.operations.get_mut(&success.id).unwrap().at =
            Instant::now() - Duration::from_secs(601);
        assert!(book
            .accept(
                instance,
                request(&HostCommand::OpenStatus {
                    operation_id: success.id
                })
                .unwrap()
            )
            .is_err());
    }

    #[test]
    fn readiness_wait_rejects_exit_replacement_failure_and_timeout_without_releasing_owner() {
        let root = std::env::temp_dir().join(format!("ms-open-wait-{}", Uuid::new_v4()));
        let owner = crate::storage_locks::VaultLock::acquire(&root).unwrap();
        let listener = ipc::Coordinator::for_worker(&owner).unwrap();
        let launch_id = Uuid::new_v4();
        let mut state = Book {
            exported: true,
            ..Book::default()
        };
        state.workers.insert("a".into(), pending(launch_id));
        let opening = request(&HostCommand::Open {
            vault_id: "a".into(),
        })
        .unwrap();
        let instance = Uuid::new_v4();
        state.accept(instance, opening).unwrap();
        let book = Arc::new(Mutex::new(state));
        assert!(wait_for_ready(&book, "a", launch_id, Instant::now()).is_err());
        assert!(crate::storage_locks::VaultLock::try_acquire(&root)
            .unwrap()
            .is_none());
        assert!(book.lock().unwrap().workers.contains_key("a"));
        assert!(wait_for_ready(&book, "missing", launch_id, Instant::now()).is_err());
        assert!(wait_for_ready(&book, "a", Uuid::new_v4(), Instant::now()).is_err());
        book.lock().unwrap().workers.get_mut("a").unwrap().error = Some("restore failed".into());
        assert!(wait_for_ready(&book, "a", launch_id, Instant::now())
            .err()
            .unwrap()
            .to_string()
            .contains("restore failed"));
        book.lock().unwrap().workers.get_mut("a").unwrap().error = None;
        let waiting_book = book.clone();
        let waiter = std::thread::spawn(move || {
            wait_for_ready(
                &waiting_book,
                "a",
                launch_id,
                Instant::now() + Duration::from_secs(2),
            )
            .map(|(endpoint, window)| (endpoint.instance(), window))
        });
        {
            let mut state = book.lock().unwrap();
            let launch = state.workers.get_mut("a").unwrap();
            launch.endpoint = Some(listener.endpoint().clone());
            launch.focused_window = Some("note_test".into());
            let ready = request(&HostCommand::Ready {
                vault_id: "a".into(),
                launch_id,
            })
            .unwrap();
            assert!(state.accept(instance, ready).unwrap().1.is_none());
        }
        assert_eq!(
            waiter.join().unwrap().unwrap(),
            (listener.endpoint().instance(), Some("note_test".into()))
        );
        book.lock().unwrap().remove_launch("a", launch_id);
        assert!(wait_for_ready(&book, "a", launch_id, Instant::now()).is_err());
        drop(listener);
        drop(owner);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn opening_client_waits_for_terminal_result_and_propagates_failure() {
        use std::sync::atomic::AtomicUsize;
        let root = std::env::temp_dir().join(format!("ms-open-client-{}", Uuid::new_v4()));
        let owner = crate::storage_locks::VaultLock::acquire(&root).unwrap();
        let listener = ipc::Coordinator::for_worker(&owner).unwrap();
        let endpoint = listener.endpoint().clone();
        let operation_id = Uuid::new_v4();
        let calls = Arc::new(AtomicUsize::new(0));
        let failure = Arc::new(AtomicBool::new(false));
        let counter = calls.clone();
        let fail = failure.clone();
        let server = listener.serve(move |request| {
            assert!(matches!(serde_json::from_value::<HostCommand>(request.payload).unwrap(), HostCommand::OpenStatus { operation_id: requested } if requested == operation_id));
            let progress = if fail.load(Ordering::Acquire) {
                OpenProgress::Failed { message: "target startup failed".into() }
            } else if counter.fetch_add(1, Ordering::AcqRel) == 0 {
                OpenProgress::Pending
            } else {
                OpenProgress::Ready
            };
            Ok(serde_json::to_value(progress).unwrap())
        }).unwrap();
        await_open_result(
            &endpoint,
            operation_id,
            Instant::now() + Duration::from_secs(2),
        )
        .unwrap();
        assert!(calls.load(Ordering::Acquire) >= 2);
        failure.store(true, Ordering::Release);
        assert!(await_open_result(&endpoint, operation_id, Instant::now())
            .unwrap_err()
            .to_string()
            .contains("target startup failed"));
        server.stop();
        drop(owner);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn worker_bootstrap_and_registration_require_the_same_host_contract() {
        let current = RuntimeContract::current().clone();
        require_host_contract(&json!({"contract":current})).unwrap();
        assert!(require_host_contract(&json!({"initialized":true})).is_err());
        assert!(require_host_contract(&json!({"contract":"invalid"})).is_err());
        let instance = Uuid::new_v4();
        let launch_id = Uuid::new_v4();
        let root = std::env::temp_dir().join(format!("ms-authorize-contract-{}", Uuid::new_v4()));
        let owner = crate::storage_locks::VaultLock::acquire(&root).unwrap();
        let listener = ipc::Coordinator::for_worker(&owner).unwrap();
        let mut book = Book {
            exported: true,
            ..Book::default()
        };
        book.workers.insert("a".into(), pending(launch_id));
        for contract in [
            RuntimeContract {
                protocol: current.protocol + 1,
                ..current.clone()
            },
            RuntimeContract {
                storage: current.storage + 1,
                ..current.clone()
            },
            RuntimeContract {
                settings_schema: "different schema".into(),
                ..current.clone()
            },
        ] {
            assert!(require_host_contract(&json!({"contract":contract})).is_err());
            for command in [
                HostCommand::Authorize {
                    vault_id: "a".into(),
                    launch_id,
                    coordinator_id: instance,
                    contract: contract.clone(),
                },
                HostCommand::Register {
                    vault_id: "a".into(),
                    launch_id,
                    endpoint: listener.endpoint().clone(),
                    contract: contract.clone(),
                },
            ] {
                assert!(book.accept(instance, request(&command).unwrap()).is_err());
                assert!(book.workers["a"].endpoint.is_none());
                assert!(!book.workers["a"].ready);
            }
            book.workers.get_mut("a").unwrap().endpoint = Some(listener.endpoint().clone());
            let adoption = HostCommand::AuthorizeAdoption {
                vault_id: "a".into(),
                launch_id,
                coordinator_id: instance,
                contract: contract.clone(),
            };
            assert!(book.accept(instance, request(&adoption).unwrap()).is_err());
            assert_eq!(
                book.workers["a"].endpoint.as_ref().unwrap().instance(),
                listener.endpoint().instance()
            );
            book.workers.get_mut("a").unwrap().endpoint = None;
        }
        // Old launch packets cannot silently bypass the new admission check.
        for command in [
            HostCommand::Authorize {
                vault_id: "a".into(),
                launch_id,
                coordinator_id: instance,
                contract: current.clone(),
            },
            HostCommand::Register {
                vault_id: "a".into(),
                launch_id,
                endpoint: listener.endpoint().clone(),
                contract: current.clone(),
            },
            HostCommand::AuthorizeAdoption {
                vault_id: "a".into(),
                launch_id,
                coordinator_id: instance,
                contract: current.clone(),
            },
        ] {
            let mut legacy = serde_json::to_value(command).unwrap();
            legacy.as_object_mut().unwrap().remove("contract");
            assert!(serde_json::from_value::<HostCommand>(legacy).is_err());
        }
        drop(listener);
        drop(owner);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn adopted_status_prunes_only_released_os_owners_and_keeps_launch_reservations() {
        let root = std::env::temp_dir().join(format!("ms-adopted-status-{}", Uuid::new_v4()));
        let owner_a = crate::storage_locks::VaultLock::acquire(&root.join("profiles/a")).unwrap();
        let owner_b = crate::storage_locks::VaultLock::acquire(&root.join("profiles/b")).unwrap();
        let mut state = Book::default();
        for id in ["a", "b", "missing", "launching", "deleting"] {
            let mut launch = pending(Uuid::new_v4());
            launch.adopted = id != "launching";
            launch.ready = matches!(id, "a" | "b");
            state.workers.insert(id.into(), launch);
        }
        state.last = Some("b".into());
        state.focus_order = vec!["a".into(), "b".into()];
        let book = Mutex::new(state);
        std::fs::create_dir_all(root.join("profiles/launching")).unwrap();
        std::fs::create_dir_all(root.join("profiles/deleting")).unwrap();
        std::fs::write(root.join("profiles/deleting/.vault-deleting"), b"retained").unwrap();
        drop(owner_b);
        // A has no listening endpoint or discovery record, but still owns its
        // physical lease. Neither absence can make it available for opening.
        reconcile_adopted(&book, &root).unwrap();
        {
            let state = book.lock().unwrap();
            assert!(state.workers.contains_key("a"));
            assert!(!state.workers.contains_key("b"));
            assert!(state.workers.contains_key("missing"));
            assert!(state.workers.contains_key("launching"));
            assert!(state.workers.contains_key("deleting"));
            assert_eq!(state.last.as_deref(), Some("a"));
        }
        assert!(!root.join("profiles/missing").exists());
        assert!(!root.join("profiles/launching/.vault.lock").exists());
        assert!(root.join("profiles/b/.vault.lock").exists());
        assert!(
            crate::storage_locks::VaultLock::try_acquire(&root.join("profiles/a"))
                .unwrap()
                .is_none()
        );
        drop(owner_a);
        reconcile_adopted(&book, &root).unwrap();
        assert!(book.lock().unwrap().last.is_none());
        assert_eq!(
            std::fs::read(root.join("profiles/deleting/.vault-deleting")).unwrap(),
            b"retained"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    fn pending(id: Uuid) -> Launch {
        Launch {
            id,
            endpoint: None,
            ready: false,
            activate_on_ready: true,
            error: None,
            adopted: false,
            focused_window: None,
        }
    }

    #[test]
    fn handoff_pins_source_identity_replays_and_fences_other_window_actions() {
        let root = std::env::temp_dir().join(format!("ms-handoff-book-{}", Uuid::new_v4()));
        let owner = crate::storage_locks::VaultLock::acquire(&root).unwrap();
        let listener = ipc::Coordinator::for_worker(&owner).unwrap();
        let instance = Uuid::new_v4();
        let launch_id = Uuid::new_v4();
        let mut book = Book {
            exported: true,
            ..Book::default()
        };
        let mut source = pending(launch_id);
        source.endpoint = Some(listener.endpoint().clone());
        source.ready = true;
        book.workers.insert("source".into(), source);
        let handoff = request(&HostCommand::HandoffFromWindow {
            source_vault_id: "source".into(),
            launch_id,
            vault_id: "target".into(),
        })
        .unwrap();
        book.recovering = true;
        assert!(book.accept(instance, handoff.clone()).is_err());
        book.recovering = false;
        let mut foreign = handoff.clone();
        foreign.payload["launch_id"] = json!(Uuid::new_v4());
        assert!(book.accept(instance, foreign).is_err());
        assert!(matches!(
            book.accept(instance, handoff.clone()).unwrap().1,
            Some(Action::Handoff { .. })
        ));
        assert_eq!(book.handoff, Some(handoff.id));
        assert!(book.accept(instance, handoff.clone()).unwrap().1.is_none());
        for command in [
            HostCommand::Quit,
            HostCommand::Activate,
            HostCommand::Open {
                vault_id: "other".into(),
            },
            HostCommand::PickerOpen {
                vault_id: "other".into(),
            },
        ] {
            assert!(book.accept(instance, request(&command).unwrap()).is_err());
        }
        assert!(book.window_state("source", launch_id).is_ok());
        book.complete_open(handoff.id, Ok(()));
        assert_eq!(book.open_status(handoff.id).unwrap(), OpenProgress::Ready);
        drop(listener);
        drop(owner);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_startup_selects_an_authenticated_surviving_worker_and_ignores_stale_registration() {
        let root = std::env::temp_dir().join(format!("ms-startup-survivor-{}", Uuid::new_v4()));
        let directory = crate::profiles::profile_dir(&root, "target");
        let owner = crate::storage_locks::VaultLock::acquire(&directory).unwrap();
        let listener = ipc::Coordinator::for_worker(&owner).unwrap();
        let record = crate::worker_registration::Registration::new(
            &root,
            "target",
            &owner,
            Uuid::new_v4(),
            listener.endpoint().clone(),
        )
        .unwrap();
        record.publish(&owner).unwrap();
        let identity = Arc::new(Mutex::new(record.identity(false)));
        let response = identity.clone();
        let server = listener
            .serve(move |_| Ok(serde_json::to_value(&*response.lock().unwrap()).unwrap()))
            .unwrap();
        let index = crate::profiles::Index {
            active: "missing".into(),
            profiles: vec![
                crate::profiles::Profile {
                    id: "missing".into(),
                    name: "Missing".into(),
                    created_at: String::new(),
                    color: None,
                },
                crate::profiles::Profile {
                    id: "target".into(),
                    name: "Target".into(),
                    created_at: String::new(),
                    color: None,
                },
            ],
        };
        assert_eq!(surviving_startup_vault(&root, &index).unwrap(), None);
        identity.lock().unwrap().ready = true;
        assert_eq!(
            surviving_startup_vault(&root, &index).unwrap(),
            Some("target".into())
        );
        drop(server);
        drop(owner);
        let deadline = Instant::now() + Duration::from_secs(5);
        while crate::storage_locks::VaultLock::is_owned(&directory).unwrap() {
            assert!(
                Instant::now() < deadline,
                "IPC ownership must release before a stale-file check"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            surviving_startup_vault(&root, &index).unwrap(),
            None,
            "a stale discovery file does not own a vault"
        );
        assert!(!crate::profiles::profile_dir(&root, "missing").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normal_launch_activation_waits_for_startup_recovery_instead_of_being_lost() {
        let mut book = Book {
            bootstrap_started: true,
            recovering: true,
            ..Book::default()
        };
        let instance = Uuid::new_v4();
        let activate = request(&HostCommand::Activate).unwrap();
        assert!(book.accept(instance, activate.clone()).unwrap().1.is_none());
        assert!(book.activate_after_startup);
        book.exported = true;
        assert!(book
            .accept(
                instance,
                request(&HostCommand::Open {
                    vault_id: "target".into()
                })
                .unwrap()
            )
            .is_err());
        assert!(book
            .accept(instance, request(&HostCommand::Activate).unwrap())
            .unwrap()
            .1
            .is_none());
        assert!(book.accept(instance, activate).unwrap().1.is_none());
        book.recovering = false;
        assert!(matches!(
            book.accept(instance, request(&HostCommand::Activate).unwrap())
                .unwrap()
                .1,
            Some(Action::ActivateLast)
        ));
    }

    #[test]
    fn coordinator_invokes_allow_only_picker_operations_in_the_picker_window() {
        for command in ["get_picker_vaults", "open_picker_vault", "create_profile"] {
            assert!(allows_host_invoke("vault-picker", command));
            assert!(!allows_host_invoke("main", command));
            assert!(!allows_host_invoke("legacy-browser-export", command));
        }
        for command in [
            "list_notes",
            "switch_profile",
            "delete_profile",
            "get_settings",
        ] {
            assert!(!allows_host_invoke("vault-picker", command));
        }
        assert!(allows_host_invoke(
            "legacy-browser-export",
            "finish_legacy_browser_export"
        ));
    }

    #[test]
    fn failed_picker_initialization_publishes_failure_and_releases_retry_reservation() {
        let instance = Uuid::new_v4();
        let mut book = Book::default();
        let first = request(&HostCommand::PickerOpen {
            vault_id: "target".into(),
        })
        .unwrap();
        book.accept(instance, first.clone()).unwrap();
        assert!(book.bootstrap_started);
        book.startup_failed(
            Some(first.id),
            AppError::InvalidArg("discovery failed".into()),
        );
        assert!(!book.bootstrap_started);
        assert!(matches!(
            book.open_status(first.id).unwrap(),
            OpenProgress::Failed { .. }
        ));
        assert!(
            book.accept(instance, first).unwrap().1.is_none(),
            "replay cannot restart a failed operation"
        );
        let retry = request(&HostCommand::PickerOpen {
            vault_id: "target".into(),
        })
        .unwrap();
        assert!(matches!(
            book.accept(instance, retry.clone()).unwrap().1,
            Some(Action::Initialize { .. })
        ));
        book.exported = true;
        book.startup_failed(
            Some(retry.id),
            AppError::InvalidArg("opening failed".into()),
        );
        assert!(book.bootstrap_started);
        assert!(
            matches!(
                book.accept(
                    instance,
                    request(&HostCommand::PickerOpen {
                        vault_id: "other".into()
                    })
                    .unwrap()
                )
                .unwrap()
                .1,
                Some(Action::Open(_))
            ),
            "exported roots retry opening without repeating initialization"
        );
    }

    #[test]
    fn startup_picker_initializes_once_and_stays_alive_without_workers() {
        let mut book = Book {
            picker_open: true,
            ..Book::default()
        };
        let instance = Uuid::new_v4();
        let jobs = crate::vault_jobs::Jobs::default();
        assert!(!book.idle_exit_candidate(&jobs));
        let select = request(&HostCommand::PickerOpen {
            vault_id: "chosen".into(),
        })
        .unwrap();
        assert!(matches!(
            book.accept(instance, select.clone()).unwrap().1,
            Some(Action::Initialize { .. })
        ));
        assert!(book.accept(instance, select).unwrap().1.is_none());
        assert!(book
            .accept(
                instance,
                request(&HostCommand::PickerOpen {
                    vault_id: "other".into(),
                })
                .unwrap()
            )
            .is_err());
    }

    #[test]
    fn a_prepared_worker_becomes_ready_without_activation_and_manual_launch_can_show_it() {
        let root = std::env::temp_dir().join(format!("ms-hidden-ready-{}", Uuid::new_v4()));
        let owner = crate::storage_locks::VaultLock::acquire(&root).unwrap();
        let listener = ipc::Coordinator::for_worker(&owner).unwrap();
        let instance = Uuid::new_v4();
        let launch_id = Uuid::new_v4();
        let mut book = Book {
            exported: true,
            ..Book::default()
        };
        let mut launch = pending(launch_id);
        launch.activate_on_ready = false;
        launch.endpoint = Some(listener.endpoint().clone());
        book.workers.insert("a".into(), launch);
        let ready = request(&HostCommand::Ready {
            vault_id: "a".into(),
            launch_id,
        })
        .unwrap();
        assert!(book.accept(instance, ready.clone()).unwrap().1.is_none());
        assert!(book.workers["a"].ready && book.had_ready_worker);
        assert!(
            book.last.is_none(),
            "hidden readiness must not become focus recency"
        );
        assert!(matches!(
            book.accept(instance, request(&HostCommand::Activate).unwrap())
                .unwrap()
                .1,
            Some(Action::ActivateLast)
        ));
        assert!(book.accept(instance, ready).unwrap().1.is_none());
        drop(listener);
        drop(owner);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn device_notices_require_registration_reject_data_and_deduplicate_replays() {
        let root = std::env::temp_dir().join(format!("ms-device-book-{}", Uuid::new_v4()));
        let ownership = crate::storage_locks::VaultLock::acquire(&root).unwrap();
        let listener = ipc::Coordinator::for_worker(&ownership).unwrap();
        let instance = Uuid::new_v4();
        let launch_id = Uuid::new_v4();
        let mut book = Book::default();
        book.workers.insert("a".into(), pending(launch_id));
        let notice = request(&HostCommand::DeviceSettingsChanged {
            vault_id: "a".into(),
            launch_id,
        })
        .unwrap();
        assert!(book.accept(instance, notice.clone()).is_err());
        book.workers.get_mut("a").unwrap().endpoint = Some(listener.endpoint().clone());
        let wrong = request(&HostCommand::DeviceSettingsChanged {
            vault_id: "a".into(),
            launch_id: Uuid::new_v4(),
        })
        .unwrap();
        assert!(book.accept(instance, wrong).is_err());
        let mut with_data = notice.clone();
        with_data.payload["values"] =
            json!({"account.serverUrl":"https://must-not-travel.example"});
        assert!(book.accept(instance, with_data).is_err());
        // Startup notices are permitted once registration succeeds. Receivers
        // are selected separately and must have completed readiness.
        assert!(matches!(
            book.accept(instance, notice.clone()).unwrap().1,
            Some(Action::RefreshDeviceSettings)
        ));
        assert!(book.accept(instance, notice).unwrap().1.is_none());
        for _ in 0..1100 {
            let changed = request(&HostCommand::DeviceSettingsChanged {
                vault_id: "a".into(),
                launch_id,
            })
            .unwrap();
            assert!(matches!(
                book.accept(instance, changed).unwrap().1,
                Some(Action::RefreshDeviceSettings)
            ));
        }
        assert_eq!(book.operations.len(), 1);
        // Ordinary lifecycle requests still have room after frequent edits.
        book.accept(instance, request(&HostCommand::Activate).unwrap())
            .unwrap();
        assert_eq!(book.operations.len(), 2);
        drop(listener);
        drop(ownership);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn device_targets_exclude_loading_failed_and_missing_endpoints() {
        let root = std::env::temp_dir().join(format!("ms-device-targets-{}", Uuid::new_v4()));
        let ownership = crate::storage_locks::VaultLock::acquire(&root).unwrap();
        let listener = ipc::Coordinator::for_worker(&ownership).unwrap();
        let mut book = Book::default();
        let id = Uuid::new_v4();
        for name in ["ready", "loading", "failed", "missing"] {
            let mut launch = pending(if name == "ready" { id } else { Uuid::new_v4() });
            launch.ready = name != "loading";
            launch.endpoint = (name != "missing").then(|| listener.endpoint().clone());
            launch.error = (name == "failed").then(|| "unavailable".into());
            book.workers.insert(name.into(), launch);
        }
        let targets = book.device_targets();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].0, id);
        assert!(targets[0].1 == *listener.endpoint());
        drop(listener);
        drop(ownership);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_focus_tracks_popouts_and_closed_workers_are_removed_from_recency() {
        let root = std::env::temp_dir().join(format!("ms-focus-book-{}", Uuid::new_v4()));
        let owner = crate::storage_locks::VaultLock::acquire(&root).unwrap();
        let listener = ipc::Coordinator::for_worker(&owner).unwrap();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let instance = Uuid::new_v4();
        let mut book = Book {
            exported: true,
            ..Book::default()
        };
        for (id, launch) in [("a", a), ("b", b)] {
            let mut worker = pending(launch);
            worker.ready = true;
            worker.endpoint = Some(listener.endpoint().clone());
            book.workers.insert(id.into(), worker);
        }
        let focus = |id: &str, launch, label: &str| {
            request(&HostCommand::Focused {
                vault_id: id.into(),
                launch_id: launch,
                window: label.into(),
            })
            .unwrap()
        };
        let old_a = focus("a", a, "main");
        book.accept(instance, old_a.clone()).unwrap();
        book.accept(instance, focus("b", b, "main")).unwrap();
        assert!(book.accept(instance, old_a).unwrap().1.is_none());
        assert_eq!(book.last.as_deref(), Some("b"));
        assert!(
            matches!(book.accept(instance, focus("a", a, "note_seed_welcome")).unwrap().1,
            Some(Action::Remember { vault_id, revision: 3 }) if vault_id == "a")
        );
        assert_eq!(
            book.workers["a"].focused_window.as_deref(),
            Some("note_seed_welcome")
        );
        assert!(
            matches!(book.accept(instance, request(&HostCommand::Activate).unwrap()).unwrap().1, Some(Action::Open(id)) if id == "a")
        );
        book.remove_launch("a", a);
        assert_eq!(book.last.as_deref(), Some("b"));
        book.remove_launch("b", b);
        assert!(book.last.is_none());

        // Closing an older worker first must remove it from the fallback list.
        book.workers.insert("a".into(), pending(a));
        book.workers.insert("b".into(), pending(b));
        book.focus_order = vec!["a".into(), "b".into()];
        book.last = Some("b".into());
        book.remove_launch("a", a);
        book.remove_launch("b", b);
        assert!(book.last.is_none());
        drop(listener);
        drop(owner);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn focus_rejects_unready_wrong_launch_and_non_vault_windows() {
        let instance = Uuid::new_v4();
        let launch_id = Uuid::new_v4();
        let mut book = Book::default();
        book.workers.insert("a".into(), pending(launch_id));
        for (launch, window) in [
            (launch_id, "main"),
            (Uuid::new_v4(), "main"),
            (launch_id, "legacy-browser-export"),
            (launch_id, "plugin-preview"),
        ] {
            assert!(book
                .accept(
                    instance,
                    request(&HostCommand::Focused {
                        vault_id: "a".into(),
                        launch_id: launch,
                        window: window.into()
                    })
                    .unwrap()
                )
                .is_err());
        }
        assert!(book.last.is_none());
        assert_eq!(book.focus_revision, 0);
    }

    #[test]
    fn replacement_host_must_be_current_and_authorize_the_exact_discovered_launch() {
        let root = std::env::temp_dir().join(format!("ms-adopt-host-{}", Uuid::new_v4()));
        let owner = crate::storage_locks::VaultLock::acquire(&root.join("profiles/a")).unwrap();
        let listener = ipc::Coordinator::for_worker(&owner).unwrap();
        let record = crate::worker_registration::Registration::new(
            &root,
            "a",
            &owner,
            Uuid::new_v4(),
            listener.endpoint().clone(),
        )
        .unwrap();
        let ipc::Election::Owner(old) = ipc::elect(&root).unwrap() else {
            panic!("new root");
        };
        let old_endpoint = old.endpoint().clone();
        let current = Mutex::new(old_endpoint.clone());
        drop(old);
        let ipc::Election::Owner(new) = ipc::elect(&root).unwrap() else {
            panic!("released root");
        };
        let new_endpoint = new.endpoint().clone();
        let permitted = Arc::new(AtomicBool::new(false));
        let gate = permitted.clone();
        let launch_id = record.launch_id;
        let instance = new_endpoint.instance();
        let server = new
            .serve(move |request| {
                let command: HostCommand = serde_json::from_value(request.payload).unwrap();
                match command {
                    HostCommand::AuthorizeAdoption {
                        vault_id,
                        launch_id: requested,
                        coordinator_id,
                        contract,
                    } if vault_id == "a"
                        && requested == launch_id
                        && coordinator_id == instance
                        && &contract == RuntimeContract::current()
                        && gate.load(Ordering::Acquire) =>
                    {
                        Ok(json!({"accepted":true}))
                    }
                    _ => Err("not authorized".into()),
                }
            })
            .unwrap();
        assert!(adopt_host(&record, &current, launch_id, old_endpoint.clone()).is_err());
        assert!(adopt_host(&record, &current, launch_id, new_endpoint.clone()).is_err());
        assert_eq!(current.lock().unwrap().instance(), old_endpoint.instance());
        permitted.store(true, Ordering::Release);
        assert!(adopt_host(&record, &current, Uuid::new_v4(), new_endpoint.clone()).is_err());
        adopt_host(&record, &current, launch_id, new_endpoint.clone()).unwrap();
        adopt_host(&record, &current, launch_id, new_endpoint.clone()).unwrap();
        assert_eq!(current.lock().unwrap().instance(), new_endpoint.instance());
        server.stop();
        drop(listener);
        drop(owner);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn adoption_authorization_requires_discovery_and_does_not_enable_normal_opens_early() {
        let root = std::env::temp_dir().join(format!("ms-adopt-book-{}", Uuid::new_v4()));
        let owner = crate::storage_locks::VaultLock::acquire(&root).unwrap();
        let listener = ipc::Coordinator::for_worker(&owner).unwrap();
        let instance = Uuid::new_v4();
        let launch_id = Uuid::new_v4();
        let mut book = Book::default();
        let authorize = || {
            request(&HostCommand::AuthorizeAdoption {
                vault_id: "a".into(),
                launch_id,
                coordinator_id: instance,
                contract: RuntimeContract::current().clone(),
            })
            .unwrap()
        };
        assert!(book.accept(instance, authorize()).is_err());
        book.workers.insert("a".into(), pending(launch_id));
        assert!(book.accept(instance, authorize()).is_err());
        book.workers.get_mut("a").unwrap().endpoint = Some(listener.endpoint().clone());
        assert!(book.accept(instance, authorize()).is_ok());
        assert!(book
            .accept(
                instance,
                request(&HostCommand::Open {
                    vault_id: "a".into()
                })
                .unwrap()
            )
            .is_err());
        book.workers.get_mut("a").unwrap().error = Some("unidentified".into());
        assert!(book.accept(instance, authorize()).is_err());
        drop(listener);
        drop(owner);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_old_exit_cannot_remove_a_replacement_worker_and_failed_launches_can_retry() {
        let old = Uuid::new_v4();
        let replacement = Uuid::new_v4();
        let mut book = Book::default();
        book.workers.insert("a".into(), pending(replacement));
        book.last = Some("a".into());
        book.remove_launch("a", old);
        assert_eq!(book.workers["a"].id, replacement);
        assert_eq!(book.last.as_deref(), Some("a"));
        book.remove_launch("a", replacement);
        assert!(!book.workers.contains_key("a"));
        assert!(book.last.is_none());
        book.workers.insert("a".into(), pending(Uuid::new_v4()));
        assert!(book.workers.contains_key("a"));
    }

    #[test]
    fn workers_need_the_exact_pending_launch_and_cannot_register_ready_before_an_endpoint() {
        let instance = Uuid::new_v4();
        let launch = Uuid::new_v4();
        let mut book = Book::default();
        book.workers.insert("default".into(), pending(launch));
        let authorize = |vault_id: &str, launch_id, coordinator_id| {
            request(&HostCommand::Authorize {
                vault_id: vault_id.into(),
                launch_id,
                coordinator_id,
                contract: RuntimeContract::current().clone(),
            })
            .unwrap()
        };
        assert!(book
            .accept(instance, authorize("default", launch, instance))
            .is_err());
        book.exported = true;
        for wrong in [
            authorize("other", launch, instance),
            authorize("default", Uuid::new_v4(), instance),
            authorize("default", launch, Uuid::new_v4()),
        ] {
            assert!(book.accept(instance, wrong).is_err());
        }
        assert!(book
            .accept(instance, authorize("default", launch, instance))
            .is_ok());
        assert!(book
            .accept(
                instance,
                request(&HostCommand::Ready {
                    vault_id: "default".into(),
                    launch_id: launch,
                })
                .unwrap()
            )
            .is_err());
        assert!(!book.workers["default"].ready);
        assert!(book.last.is_none());
    }

    #[test]
    fn relaunch_retries_a_kept_update_session_once_and_fences_opens_meanwhile() {
        let instance = Uuid::new_v4();
        let mut book = Book {
            exported: true,
            update_retry: true,
            last: Some("default".into()),
            ..Book::default()
        };
        let activate = || request(&HostCommand::Activate).unwrap();
        let (_, action) = book.accept(instance, activate()).unwrap();
        assert!(matches!(action, Some(Action::RetryRecovery)));
        assert!(book.recovering && !book.update_retry);
        assert!(book
            .accept(
                instance,
                request(&HostCommand::Open {
                    vault_id: "default".into()
                })
                .unwrap()
            )
            .is_err());
        // A second launch during the retry only asks for later activation.
        let (_, action) = book.accept(instance, activate()).unwrap();
        assert!(action.is_none() && book.activate_after_startup);
        book.recovering = false;
        let (_, action) = book.accept(instance, activate()).unwrap();
        assert!(matches!(action, Some(Action::Open(id)) if id == "default"));
    }

    #[test]
    fn a_failing_handoff_backs_off_and_is_given_up_after_its_retries_or_the_overall_limit() {
        let start = Instant::now();
        let mut book = Book::default();
        assert!(!book.handoff_failed(start));
        assert_eq!(book.handoff_retry_at, Some(start + Duration::from_secs(5)));
        assert!(!book.handoff_failed(start));
        assert_eq!(book.handoff_retry_at, Some(start + Duration::from_secs(10)));
        assert!(book.handoff_failed(start));
        book.handoff_settled();
        assert!(book.handoff_retry_at.is_none());
        assert!(!book.handoff_failed(start));
        assert!(book.handoff_failed(start + RECOVERY_LIMIT));
    }

    #[test]
    fn only_the_unready_launch_can_fail_its_startup_and_it_cannot_become_ready_afterwards() {
        let instance = Uuid::new_v4();
        let launch = Uuid::new_v4();
        let mut book = Book {
            exported: true,
            ..Book::default()
        };
        book.workers.insert("default".into(), pending(launch));
        let failed = |launch_id, message: &str| {
            request(&HostCommand::StartupFailed {
                vault_id: "default".into(),
                launch_id,
                message: message.into(),
            })
            .unwrap()
        };
        for wrong in [
            failed(Uuid::new_v4(), "settings unavailable"),
            failed(launch, ""),
            failed(launch, &"x".repeat(STARTUP_FAILURE_MAX + 1)),
        ] {
            assert!(book.accept(instance, wrong).is_err());
        }
        assert!(book.ready_endpoint("default", launch).unwrap().is_none());
        book.accept(instance, failed(launch, "settings unavailable"))
            .unwrap();
        book.accept(instance, failed(launch, "later")).unwrap();
        assert!(book
            .ready_endpoint("default", launch)
            .err()
            .unwrap()
            .to_string()
            .contains("settings unavailable"));
        assert!(book
            .accept(
                instance,
                request(&HostCommand::Ready {
                    vault_id: "default".into(),
                    launch_id: launch,
                })
                .unwrap()
            )
            .is_err());

        let ready = Uuid::new_v4();
        let mut running = pending(ready);
        running.ready = true;
        book.workers.insert("other".into(), running);
        assert!(book
            .accept(
                instance,
                request(&HostCommand::StartupFailed {
                    vault_id: "other".into(),
                    launch_id: ready,
                    message: "late".into(),
                })
                .unwrap()
            )
            .is_err());
        assert!(book.workers["other"].error.is_none());
    }

    #[test]
    fn a_retried_old_ready_request_cannot_reactivate_it_after_another_vault_became_ready() {
        let root = std::env::temp_dir().join(format!("ms-runtime-book-{}", Uuid::new_v4()));
        let owner = crate::storage_locks::VaultLock::acquire(&root).unwrap();
        let listener = ipc::Coordinator::for_worker(&owner).unwrap();
        let endpoint = listener.endpoint().clone();
        let instance = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let mut book = Book {
            exported: true,
            ..Book::default()
        };
        for (id, launch) in [("a", a), ("b", b)] {
            book.workers.insert(id.into(), pending(launch));
            book.accept(
                instance,
                request(&HostCommand::Register {
                    vault_id: id.into(),
                    launch_id: launch,
                    endpoint: endpoint.clone(),
                    contract: RuntimeContract::current().clone(),
                })
                .unwrap(),
            )
            .unwrap();
        }
        let ready = request(&HostCommand::Ready {
            vault_id: "a".into(),
            launch_id: a,
        })
        .unwrap();
        assert!(
            matches!(book.accept(instance, ready.clone()).unwrap().1, Some(Action::Open(id)) if id == "a")
        );
        book.accept(
            instance,
            request(&HostCommand::Ready {
                vault_id: "b".into(),
                launch_id: b,
            })
            .unwrap(),
        )
        .unwrap();
        book.accept(
            instance,
            request(&HostCommand::Focused {
                vault_id: "b".into(),
                launch_id: b,
                window: "main".into(),
            })
            .unwrap(),
        )
        .unwrap();
        assert!(book.accept(instance, ready.clone()).unwrap().1.is_none());
        assert_eq!(book.last.as_deref(), Some("b"));
        assert!(book
            .accept(
                instance,
                request(&HostCommand::Ready {
                    vault_id: "a".into(),
                    launch_id: a,
                })
                .unwrap()
            )
            .unwrap()
            .1
            .is_none());
        assert_eq!(book.last.as_deref(), Some("b"));
        let changed = Request {
            id: ready.id,
            payload: request(&HostCommand::Open {
                vault_id: "b".into(),
            })
            .unwrap()
            .payload,
        };
        assert!(book.accept(instance, changed).is_err());
        assert!(book
            .accept(
                instance,
                request(&HostCommand::Register {
                    vault_id: "a".into(),
                    launch_id: a,
                    endpoint,
                    contract: RuntimeContract::current().clone(),
                })
                .unwrap()
            )
            .is_err());
        drop(listener);
        drop(owner);
        std::fs::remove_dir_all(root).unwrap();
    }
}
