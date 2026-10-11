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
    DeviceSettingsChanged {
        vault_id: String,
        launch_id: Uuid,
    },
    Authorize {
        vault_id: String,
        launch_id: Uuid,
        coordinator_id: Uuid,
    },
    AuthorizeAdoption {
        vault_id: String,
        launch_id: Uuid,
        coordinator_id: Uuid,
    },
    Register {
        vault_id: String,
        launch_id: Uuid,
        endpoint: Endpoint,
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
    RefreshDeviceSettings {
        launch_id: Uuid,
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
}
#[derive(Default)]
struct Book {
    exported: bool,
    last: Option<String>,
    workers: BTreeMap<String, Launch>,
    operations: BTreeMap<Uuid, Operation>,
    focus_order: Vec<String>,
    focus_revision: u64,
}

enum Action {
    Open(String),
    ActivateLast,
    Remember { vault_id: String, revision: u64 },
    RefreshDeviceSettings,
}

impl Book {
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
            HostCommand::Status => {
                return Ok((
                    json!({"initialized":self.exported,"active":self.last,"workers":self.workers.iter().map(|(id, launch)| json!({
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
            } => {
                if coordinator_id != instance
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
            } => {
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
            } => {
                if coordinator_id != instance
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
                    action = Some(Action::Open(vault_id));
                }
            }
        }
        let reply = json!({"accepted":true});
        self.operations.insert(
            request.id,
            Operation {
                input: request.payload,
                reply: reply.clone(),
                at: Instant::now(),
            },
        );
        Ok((reply, action))
    }
}
pub struct Host {
    instance: Uuid,
    endpoint: Endpoint,
    book: Mutex<Book>,
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

fn request(command: &HostCommand) -> AppResult<Request> {
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
    let vault = crate::profiles::profile_dir(&root, &index.active);
    crate::legacy_content::initialize_owner(&root, &index.active, &vault)?;
    let instance = coordinator.endpoint().instance();
    let endpoint = coordinator.endpoint().clone();
    let handle = app.handle().clone();
    let server = coordinator.serve(move |request| {
        handle_host(&handle, request)
            .map_err(|_| "vault request unavailable; ownership retained".into())
    })?;
    app.manage(Host {
        instance,
        endpoint,
        book: Mutex::new(Book::default()),
        device_notifications: crate::device_notifications::Notifications::default(),
        _server: server,
    });
    let initial = index.active;
    crate::legacy_export::begin(
        app,
        initial.clone(),
        Box::new(move |app| {
            let task_app = app.clone();
            if let Err(error) = std::thread::Builder::new()
                .name("vault-recovery".into())
                .spawn(move || {
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
                    if let Err(error) = open(&task_app, &target) {
                        log::error!("[vaults] initial launch failed: {error}");
                    }
                    broadcast_device_settings(&task_app);
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
            HostCommand::Status => Ok(json!({"initialized":false,"active":null,"workers":[]})),
            HostCommand::Activate => Ok(json!({"accepted":true})),
            _ => Err(invalid()),
        };
    };
    // Replies are acknowledgements. Root filesystem work and worker IPC run
    // after this short critical section, never under the root document lock.
    let request_id = request.id;
    let (reply, action) = host
        .book
        .lock()
        .map_err(|_| invalid())?
        .accept(host.instance, request)?;
    if let Some(action) = action {
        let task_app = app.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("vault-open".into())
            .spawn(move || {
                let target = match action {
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
                        return;
                    }
                    Action::RefreshDeviceSettings => {
                        broadcast_device_settings(&task_app);
                        return;
                    }
                };
                if let Err(error) = target.and_then(|vault_id| open(&task_app, &vault_id)) {
                    log::error!("[vaults] open request failed: {error}");
                }
            })
        {
            if let Ok(mut book) = host.book.lock() {
                book.operations.remove(&request_id);
            }
            return Err(error.into());
        }
    }
    Ok(reply)
}

fn open(app: &AppHandle, vault_id: &str) -> AppResult<()> {
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
    if !book.exported {
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
                return open(app, vault_id);
            }
        }
        if let Some(endpoint) = endpoint {
            let probe = endpoint
                .retry_call(&Request {
                    id: Uuid::new_v4(),
                    payload: serde_json::to_value(WorkerCommand::Identify { launch_id })
                        .map_err(|_| invalid())?,
                })
                .and_then(|reply| reply.map_err(AppError::InvalidArg));
            let identity = probe.and_then(|reply| {
                serde_json::from_value::<crate::worker_registration::Identity>(reply)
                    .map_err(|_| invalid())
            });
            let result = identity.and_then(|identity| {
                identity.require_compatible()?;
                if identity.launch_id != launch_id
                    || identity.vault_id != vault_id
                    || !identity.ready
                    || identity.root != std::fs::canonicalize(&root)?
                    || identity.directory != std::fs::canonicalize(&directory)?
                {
                    return Err(invalid());
                }
                crate::foreground::transfer(&endpoint);
                Ok(())
            });
            if let Err(error) = result {
                return retry_after_released_owner(app, &root, vault_id, launch_id, error);
            }
            let result = endpoint
                .call(&Request {
                    id: Uuid::new_v4(),
                    payload: serde_json::to_value(WorkerCommand::Activate {
                        window: focused_window,
                    })
                    .map_err(|_| invalid())?,
                })
                .and_then(|reply| reply.map_err(AppError::InvalidArg));
            if let Err(error) = result {
                return retry_after_released_owner(app, &root, vault_id, launch_id, error);
            }
        }
        return Ok(());
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
    Ok(())
}

fn retry_after_released_owner(
    app: &AppHandle,
    root: &std::path::Path,
    id: &str,
    launch_id: Uuid,
    error: AppError,
) -> AppResult<()> {
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
            open(app, id)
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
    host.retry_call(&request(&HostCommand::Authorize {
        vault_id: vault_id.clone(),
        launch_id: *launch_id,
        coordinator_id: *coordinator_id,
    })?)?
    .map_err(AppError::InvalidArg)?;
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
        let command: WorkerCommand = serde_json::from_value(request.payload)
            .map_err(|_| "invalid worker request".to_string())?;
        match command {
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
                let app = handle.clone();
                handle
                    .run_on_main_thread(move || {
                        crate::worker_shutdown::request_close(&app);
                    })
                    .map_err(|_| "worker close unavailable".to_string())?;
                Ok(json!({"accepted":true}))
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
            .map_err(AppError::InvalidArg)
    })
    .await
    .map_err(|_| invalid())??)
}

#[cfg(test)]
mod tests {
    use super::*;

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
                    } if vault_id == "a"
                        && requested == launch_id
                        && coordinator_id == instance
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
                })
                .unwrap()
            )
            .is_err());
        drop(listener);
        drop(owner);
        std::fs::remove_dir_all(root).unwrap();
    }
}
