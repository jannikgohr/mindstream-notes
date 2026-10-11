//! Supervised runtime integration. Startup remains opt-in while platform
//! activation, coordinator recovery and OS integrations are being completed.
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
    Focused {
        vault_id: String,
        launch_id: Uuid,
        window: String,
    },
    Open {
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
    ShortcutRegistrationStatus,
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
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "command", rename_all = "camelCase", deny_unknown_fields)]
enum WorkerCommand {
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
    QuitFailed {
        launch_id: Uuid,
        message: String,
    },
    CloseStatus {
        launch_id: Uuid,
        operation_id: Uuid,
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
    error: Option<String>,
    adopted: bool,
    focused_window: Option<String>,
}
struct Operation {
    input: Value,
    reply: Value,
    at: Instant,
    open_result: Option<Result<(), String>>,
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
    quitting: Option<Uuid>,
    last: Option<String>,
    workers: BTreeMap<String, Launch>,
    operations: BTreeMap<Uuid, Operation>,
    focus_order: Vec<String>,
    shortcut_order: Vec<String>,
    focus_revision: u64,
}

enum Action {
    Quit,
    Open(String),
    ActivateLast,
    Remember { vault_id: String, revision: u64 },
    RefreshDeviceSettings,
    Shortcut(crate::hotkeys::GlobalShortcutCommandId, Option<String>),
}

impl Book {
    fn open_status(&self, operation_id: Uuid) -> AppResult<OpenProgress> {
        let operation = self.operations.get(&operation_id).ok_or_else(invalid)?;
        if !matches!(
            operation.input["command"].as_str(),
            Some("open" | "shortcut" | "quit")
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
                    Some("open" | "shortcut" | "quit")
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
        self.operations
            .retain(|_, operation| operation.at.elapsed() < Duration::from_secs(600));
        if let Some(operation) = self.operations.get(&request.id) {
            if operation.input != request.payload {
                return Err(invalid());
            }
            return Ok((operation.reply.clone(), None));
        }
        if let HostCommand::OpenStatus { operation_id } = command {
            return Ok((
                serde_json::to_value(self.open_status(operation_id)?).map_err(|_| invalid())?,
                None,
            ));
        }
        if let Some(operation_id) = self.quitting {
            if matches!(command, HostCommand::Quit) {
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
                    },
                );
                return Ok((reply, None));
            }
            if matches!(
                command,
                HostCommand::Open { .. } | HostCommand::Activate | HostCommand::Shortcut { .. }
            ) {
                return Err(AppError::InvalidArg(
                    "the app is quitting; no new vault action was started".into(),
                ));
            }
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
            HostCommand::Quit => {
                if !self.exported {
                    return Err(invalid());
                }
                self.quitting = Some(request.id);
                action = Some(Action::Quit);
            }
            HostCommand::OpenStatus { .. } | HostCommand::ShortcutRegistrationStatus => {
                unreachable!()
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
                    json!({"contract":RuntimeContract::current(),"initialized":self.exported,"active":self.last,"quitting":self.quitting,"workers":self.workers.iter().map(|(id, launch)| json!({
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
                if self.exported {
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
                    // Tracked requests perform their own authenticated activation
                    // before publishing success. Startup still activates here.
                    if self.quitting.is_none()
                        && !self.operations.values().any(|operation| {
                            operation.input["command"].as_str() == Some("open")
                                && operation.input["vault_id"].as_str() == Some(vault_id.as_str())
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

/// Preserve existing direct e2e devices and normal startup until the full
/// supervised path passes its release gates. Explicit workers cannot fall back.
pub fn startup_role(kind: crate::environment::Kind) -> AppResult<Role> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args
        .iter()
        .any(|a| a == "--supervised-vaults" || a == "--vault-worker")
    {
        Role::parse(kind, &args)
    } else {
        Ok(Role::Direct)
    }
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
            let (endpoint, reply) =
                ipc::request_with_endpoint(&root, &request(&HostCommand::Status)?)?;
            reply.map_err(AppError::InvalidArg)?;
            crate::foreground::transfer(&endpoint);
            endpoint
                .retry_call(&request(&HostCommand::Activate)?)?
                .map_err(AppError::InvalidArg)?;
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
    // Seed/recover device settings before a second worker can win the first
    // migration race. The startup-selected vault is the sole legacy source.
    app.manage(
        crate::desktop_settings::DesktopSettings::load_for_coordinator(&root, &index.active)
            .map_err(|error| AppError::InvalidArg(error.to_string()))?,
    );
    let vault = crate::profiles::profile_dir(&root, &index.active);
    crate::legacy_content::initialize_owner(&root, &index.active, &vault)?;
    let instance = coordinator.endpoint().instance();
    let endpoint = coordinator.endpoint().clone();
    let handle = app.handle().clone();
    let server = coordinator.serve(move |request| {
        handle_host(&handle, request)
            .map_err(|_| "vault request unavailable; ownership retained".into())
    })?;
    app.manage(crate::coordinator_shortcuts::Shortcuts::default());
    app.manage(Host {
        instance,
        endpoint,
        book: Mutex::new(Book::default()),
        jobs: crate::vault_jobs::Jobs::default(),
        device_notifications: crate::device_notifications::Notifications::default(),
        _server: server,
    });
    #[cfg(target_os = "macos")]
    crate::native_menu::init(app)?;
    let initial = index.active;
    crate::legacy_export::begin(
        app,
        initial.clone(),
        Box::new(move |app| {
            let task_app = app.clone();
            let Ok(job) = app.state::<Host>().jobs.enter() else {
                return;
            };
            if let Err(error) = std::thread::Builder::new()
                .name("vault-recovery".into())
                .spawn(move || {
                    let _job = job;
                    if let Err(error) = recover_workers(&task_app) {
                        log::error!("[vaults] worker discovery failed: {error}");
                        return;
                    }
                    let mut target = initial;
                    if let Some(host) = task_app.try_state::<Host>() {
                        if let Ok(mut book) = host.book.lock() {
                            book.exported = true;
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
                    if let Err(error) = open(&task_app, &target, true) {
                        log::error!("[vaults] initial launch failed: {error}");
                    }
                    broadcast_device_settings(&task_app);
                    crate::coordinator_shortcuts::refresh(&task_app);
                })
            {
                log::error!("[vaults] recovery thread unavailable: {error}");
            }
        }),
    )?;
    Ok(())
}

fn recover_workers(app: &AppHandle) -> AppResult<()> {
    let root = crate::paths::app_data_root(app)?;
    let index = crate::profiles::prepare_coordinator_index(&root)?;
    for vault in index.profiles {
        if let Err(error) = recover_worker(app, &root, &vault.id) {
            let host = app.state::<Host>();
            host.book.lock().map_err(|_| invalid())?.workers.insert(
                vault.id,
                Launch {
                    id: Uuid::nil(),
                    endpoint: None,
                    ready: false,
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
    let tracked_open = matches!(
        command,
        HostCommand::Open { .. } | HostCommand::Shortcut { .. }
    );
    let status_request = matches!(command, HostCommand::Status);
    if matches!(
        command,
        HostCommand::Status
            | HostCommand::Activate
            | HostCommand::Open { .. }
            | HostCommand::Shortcut { .. }
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
        let job = if action.as_ref().is_some_and(|a| !matches!(a, Action::Quit)) {
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
                    Action::Quit => {
                        finish_quit(&task_app, request_id);
                        return;
                    }
                    Action::Open(id) => Ok(id),
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
                        broadcast_device_settings(&task_app);
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
        let mut errors = Vec::new();
        // Start independent close/save requests together, with bounded threads.
        // No Book/root-document lock crosses a worker IPC call or wait.
        for chunk in targets.chunks(8) {
            std::thread::scope(|scope| {
                let handles: Vec<_> = chunk
                    .iter()
                    .map(|(id, launch)| {
                        let root = &root;
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
                        Err(_) => {
                            errors.push("worker close task failed; ownership retained".into())
                        }
                    }
                }
            });
        }
        if !errors.is_empty() {
            return Err(AppError::InvalidArg(errors.join("; ")));
        }
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
    if let Some(launch) = book.workers.get(vault_id) {
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
    let launch_id = Uuid::new_v4();
    book.workers.insert(
        vault_id.into(),
        Launch {
            id: launch_id,
            endpoint: None,
            ready: false,
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
    let deadline = Instant::now() + OPEN_TIMEOUT;
    let launch_id = open(app, vault_id, false)?;
    let host = app.state::<Host>();
    let (endpoint, window) = wait_for_ready(&host.book, vault_id, launch_id, deadline)?;
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
    let server = listener.serve(move |request| {
        let request_id = request.id;
        let command: WorkerCommand = serde_json::from_value(request.payload)
            .map_err(|_| "invalid worker request".to_string())?;
        match command {
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
            WorkerCommand::RefreshDeviceSettings { launch_id } => {
                if launch_id != registration.launch_id || !worker_ready.load(Ordering::Acquire) {
                    return Err("worker settings refresh unavailable".into());
                }
                handle
                    .emit(crate::app_events::AppEvent::UiSettingsChanged.as_str(), ())
                    .map_err(|_| "worker settings notification unavailable".to_string())?;
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
    Ok(())
}

#[tauri::command]
pub async fn vault_worker_ready(app: AppHandle, window: WebviewWindow) -> CommandResult<()> {
    if window.label() != "main" {
        return Ok(());
    }
    let Some(worker) = app.try_state::<Worker>() else {
        return Ok(());
    };
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
pub async fn open_profile_window(app: AppHandle, id: String) -> CommandResult<()> {
    let worker = app.try_state::<Worker>().ok_or_else(invalid)?;
    let request = request(&HostCommand::Open { vault_id: id })?;
    let host = worker.host.lock().map_err(|_| invalid())?.clone();
    let probe = self::request(&HostCommand::Status)?;
    Ok(tauri::async_runtime::spawn_blocking(move || {
        crate::foreground::after_probe(&host, &probe)?;
        host.retry_call(&request)?
            .map(|_| ())
            .map_err(AppError::InvalidArg)?;
        await_open_result(
            &host,
            request.id,
            Instant::now() + OPEN_TIMEOUT + Duration::from_secs(10),
        )
    })
    .await
    .map_err(|_| invalid())??)
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
            error: None,
            adopted: false,
            focused_window: None,
        }
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
