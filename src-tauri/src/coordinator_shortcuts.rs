//! OS registrations belong to the root coordinator. Workers publish changes,
//! and canonical root bindings are shared with the frontend through one manifest.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::error::{AppError, AppResult};
use crate::hotkeys::GlobalShortcutCommandId;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Definition {
    id: String,
    command_id: GlobalShortcutCommandId,
    default_binding: Option<String>,
}
#[derive(Deserialize)]
struct Contract {
    commands: Vec<Definition>,
    keys: BTreeMap<String, String>,
}
static CONTRACT: LazyLock<Contract> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../src/lib/hotkeys/global-shortcuts.json"))
        .expect("bundled global shortcut contract")
});

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Binding {
    pub command_id: String,
    pub accelerator: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Status {
    pub coordinated: bool,
    pub settling: bool,
    pub registered: Vec<Binding>,
    pub error: Option<String>,
}

#[derive(Default)]
struct Registry {
    registered: Vec<Binding>,
    error: Option<String>,
    settled: u64,
}
#[derive(Default)]
pub(crate) struct Shortcuts {
    generation: AtomicU64,
    running: AtomicBool,
    suspended: AtomicBool,
    registry: Mutex<Registry>,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidArg(message.into())
}

fn accelerator(binding: &str) -> AppResult<String> {
    let input = binding.trim().to_lowercase();
    let mut modifiers = BTreeSet::new();
    let mut key = None;
    for token in input.split('+').map(str::trim) {
        match token {
            "mod" | "ctrl" | "alt" | "shift" => {
                modifiers.insert(token);
            }
            "control" => {
                modifiers.insert("ctrl");
            }
            _ if !token.is_empty() && key.is_none() => key = Some(token),
            _ => return Err(invalid("invalid system-wide shortcut binding")),
        }
    }
    let key = key.ok_or_else(|| invalid("shortcut binding has no key"))?;
    let key = match key {
        "esc" => "escape",
        "return" => "enter",
        "del" => "delete",
        "ins" => "insert",
        "up" => "arrowup",
        "down" => "arrowdown",
        "left" => "arrowleft",
        "right" => "arrowright",
        "spacebar" => "space",
        "-" => "minus",
        other => other,
    };
    let function_key = key
        .strip_prefix('f')
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (1..=24).contains(&n));
    if modifiers.is_empty()
        && !(function_key
            || matches!(
                key,
                "escape"
                    | "enter"
                    | "tab"
                    | "backspace"
                    | "delete"
                    | "insert"
                    | "home"
                    | "end"
                    | "pageup"
                    | "pagedown"
                    | "arrowup"
                    | "arrowdown"
                    | "arrowleft"
                    | "arrowright"
            ))
    {
        return Err(invalid("unmodified printable shortcut is not allowed"));
    }
    let name = CONTRACT
        .keys
        .get(key)
        .ok_or_else(|| invalid("unsupported system-wide shortcut key"))?;
    let mut parts = Vec::new();
    for (token, native) in [
        ("mod", "CommandOrControl"),
        ("ctrl", "Ctrl"),
        ("alt", "Alt"),
        ("shift", "Shift"),
    ] {
        if modifiers.contains(token) {
            parts.push(native);
        }
    }
    parts.push(name);
    let result = parts.join("+");
    result
        .parse::<Shortcut>()
        .map_err(|_| invalid("native shortcut parser rejected binding"))?;
    Ok(result)
}

fn bindings(values: &BTreeMap<String, Value>) -> AppResult<Vec<Binding>> {
    let mut result = Vec::new();
    let mut ids = BTreeSet::new();
    for command in &CONTRACT.commands {
        let key = format!("hotkey.{}", command.id);
        let binding = match values.get(&key) {
            None => command.default_binding.as_deref(),
            Some(Value::Null) => None,
            Some(Value::String(binding)) => Some(binding.as_str()),
            Some(_) => {
                return Err(invalid(
                    "system-wide shortcut binding must be a string or null",
                ))
            }
        };
        let Some(binding) = binding else {
            continue;
        };
        let accelerator =
            accelerator(binding).map_err(|error| invalid(format!("{}: {error}", command.id)))?;
        let shortcut = accelerator
            .parse::<Shortcut>()
            .map_err(|_| invalid("invalid shortcut"))?;
        if !ids.insert(shortcut.id()) {
            return Err(invalid(
                "system-wide shortcut bindings conflict on this platform",
            ));
        }
        result.push(Binding {
            command_id: command.id.clone(),
            accelerator,
        });
    }
    Ok(result)
}

/// Caller holds RootLock. A failed removal must never let a stale native
/// callback execute a command whose binding was changed meanwhile.
pub(crate) fn require_current_binding(
    root: &std::path::Path,
    command: GlobalShortcutCommandId,
    expected: Option<&str>,
) -> AppResult<()> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let plan = bindings(&crate::ui_settings::shortcut_bindings(root)?)?;
    if !plan.iter().any(|binding| {
        binding.command_id == command.hotkey_catalogue_id() && binding.accelerator == expected
    }) {
        return Err(invalid("shortcut binding changed before execution"));
    }
    Ok(())
}

trait Registration {
    fn unregister(&mut self, binding: &Binding) -> Result<(), String>;
    fn register(&mut self, binding: &Binding) -> Result<(), String>;
}

impl Registry {
    fn reconcile(&mut self, desired: AppResult<Vec<Binding>>, os: &mut impl Registration) {
        let (desired, mut errors) = match desired {
            Ok(desired) => (desired, Vec::new()),
            Err(error) => (Vec::new(), vec![error.to_string()]),
        };
        self.registered.retain(|binding| {
            if desired.contains(binding) {
                return true;
            }
            match os.unregister(binding) {
                Ok(()) => false,
                Err(error) => {
                    errors.push(error);
                    true
                }
            }
        });
        for binding in desired {
            if self.registered.contains(&binding) {
                continue;
            }
            match os.register(&binding) {
                Ok(()) => self.registered.push(binding),
                Err(error) => errors.push(error),
            }
        }
        self.error = (!errors.is_empty()).then(|| errors.join("; "));
    }
}

struct Native<'a>(&'a AppHandle);
impl Registration for Native<'_> {
    fn unregister(&mut self, binding: &Binding) -> Result<(), String> {
        self.0
            .global_shortcut()
            .unregister(binding.accelerator.as_str())
            .map_err(|error| format!("{}: {error}", binding.command_id))
    }
    fn register(&mut self, binding: &Binding) -> Result<(), String> {
        let command = CONTRACT
            .commands
            .iter()
            .find(|command| command.id == binding.command_id)
            .ok_or("unknown shortcut command")?
            .command_id;
        let pressed = AtomicBool::new(false);
        let accelerator = binding.accelerator.clone();
        self.0
            .global_shortcut()
            .on_shortcut(binding.accelerator.as_str(), move |app, _, event| {
                if event.state == ShortcutState::Released {
                    pressed.store(false, Ordering::Release);
                    return;
                }
                if pressed.swap(true, Ordering::AcqRel) {
                    return;
                }
                crate::vault_supervisor::run_shortcut(app, command, accelerator.clone());
            })
            .map_err(|error| format!("{}: {error}", binding.command_id))
    }
}

fn desired(app: &AppHandle) -> AppResult<Vec<Binding>> {
    if app.state::<Shortcuts>().suspended.load(Ordering::Acquire)
        || !crate::environment::os_integrations_enabled()
    {
        return Ok(Vec::new());
    }
    if !crate::vault_supervisor::shortcut_destination_available(app)? {
        return Ok(Vec::new());
    }
    let root = crate::paths::app_data_root(app)?;
    let _lock = crate::storage_locks::RootLock::acquire(&root)?;
    bindings(&crate::ui_settings::shortcut_bindings(&root)?)
}

pub(crate) fn suspend(app: &AppHandle, suspended: bool) {
    app.state::<Shortcuts>()
        .suspended
        .store(suspended, Ordering::Release);
    refresh(app);
}

pub(crate) fn status(app: &AppHandle) -> AppResult<Status> {
    let state = app.state::<Shortcuts>();
    let registry = state
        .registry
        .lock()
        .map_err(|_| invalid("shortcut registration state unavailable"))?;
    Ok(Status {
        coordinated: true,
        settling: registry.settled != state.generation.load(Ordering::Acquire),
        registered: registry.registered.clone(),
        error: registry.error.clone(),
    })
}

/// Called off the native event thread. Coalesce edits without holding RootLock
/// across OS registration or contacting worker processes. Keep failed removals
/// tracked and retry on the next notice, rather than silently leaking bindings.
pub(crate) fn refresh(app: &AppHandle) {
    let state = app.state::<Shortcuts>();
    state.generation.fetch_add(1, Ordering::AcqRel);
    if state.running.swap(true, Ordering::AcqRel) {
        return;
    }
    loop {
        let generation = state.generation.load(Ordering::Acquire);
        let desired = desired(app);
        if let Ok(mut registry) = state.registry.lock() {
            registry.reconcile(desired, &mut Native(app));
            registry.settled = generation;
            if let Some(error) = &registry.error {
                log::warn!("[shortcuts] registration failed: {error}");
            }
        }
        if state.generation.load(Ordering::Acquire) != generation {
            continue;
        }
        state.running.store(false, Ordering::Release);
        if state.generation.load(Ordering::Acquire) == generation
            || state
                .running
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Fake {
        live: Vec<Binding>,
        fail_add: bool,
        fail_remove: bool,
    }
    impl Registration for Fake {
        fn unregister(&mut self, binding: &Binding) -> Result<(), String> {
            if self.fail_remove {
                return Err("busy removal".into());
            }
            self.live.retain(|value| value != binding);
            Ok(())
        }
        fn register(&mut self, binding: &Binding) -> Result<(), String> {
            if self.fail_add {
                return Err("OS conflict".into());
            }
            self.live.push(binding.clone());
            Ok(())
        }
    }
    #[test]
    fn defaults_overrides_unset_unsupported_and_platform_collisions() {
        let mut values = BTreeMap::new();
        let defaults = bindings(&values).unwrap();
        assert_eq!(defaults.len(), 3);
        assert_eq!(defaults[0].accelerator, "CommandOrControl+Alt+KeyN");
        values.insert("hotkey.global.newMarkdownNote".into(), Value::Null);
        values.insert("hotkey.global.showApp".into(), Value::from("F12"));
        assert_eq!(bindings(&values).unwrap().len(), 3);
        values.insert("hotkey.global.showApp".into(), Value::from("ctrl+alt+ö"));
        assert!(bindings(&values).is_err());
        values.insert("hotkey.global.showApp".into(), Value::from("mod+alt+d"));
        assert!(bindings(&values).is_err());
        values.insert("hotkey.global.showApp".into(), Value::from(false));
        assert!(bindings(&values).is_err());
        assert!(accelerator("a").is_err());
        assert!(accelerator("alt++").is_err());
        assert_eq!(
            accelerator("SHIFT + control + esc").unwrap(),
            "Ctrl+Shift+Escape"
        );
        for key in CONTRACT.keys.keys() {
            assert!(accelerator(&format!("mod+{key}")).is_ok(), "{key}");
        }
        #[cfg(not(target_os = "macos"))]
        assert_eq!(
            accelerator("mod+alt+d")
                .unwrap()
                .parse::<Shortcut>()
                .unwrap()
                .id(),
            accelerator("ctrl+alt+d")
                .unwrap()
                .parse::<Shortcut>()
                .unwrap()
                .id()
        );
    }
    #[test]
    fn failed_registration_and_removal_remain_visible_and_retry_without_leaks() {
        let desired = bindings(&BTreeMap::new()).unwrap();
        let mut registry = Registry::default();
        let mut os = Fake {
            fail_add: true,
            ..Fake::default()
        };
        registry.reconcile(Ok(desired.clone()), &mut os);
        assert!(registry.registered.is_empty());
        assert!(registry.error.is_some());
        os.fail_add = false;
        registry.reconcile(Ok(desired.clone()), &mut os);
        assert_eq!(registry.registered, desired);
        assert!(registry.error.is_none());
        registry.reconcile(Ok(desired.clone()), &mut os);
        assert_eq!(os.live.len(), 3);
        os.fail_remove = true;
        registry.reconcile(Ok(Vec::new()), &mut os);
        assert_eq!(registry.registered.len(), 3);
        assert!(registry.error.is_some());
        os.fail_remove = false;
        registry.reconcile(Err(invalid("corrupt settings")), &mut os);
        assert!(registry.registered.is_empty());
        assert!(os.live.is_empty());
        assert!(registry.error.is_some());
        registry.reconcile(Ok(Vec::new()), &mut os);
        assert!(registry.error.is_none());
    }
}
