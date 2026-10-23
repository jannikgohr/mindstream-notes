use serde::Serialize;
use std::sync::Mutex;
use tauri::{
    image::Image,
    menu::{IconMenuItem, Menu, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager,
};

use crate::{
    app_events::AppEvent,
    db::Db,
    desktop_settings::DesktopSettings,
    hotkeys::GlobalShortcutCommandId,
    i18n,
    notes::{self, CreateNote, NoteKind},
};

#[cfg(target_os = "linux")]
mod linux_menu;

const TRAY_ID: &str = "main-tray";
const NEW_NOTE_ID: &str = "new_note";
const NEW_DRAWING_ID: &str = "new_drawing";
const NEW_INK_ID: &str = "new_ink";
const NEW_DIAGRAM_ID: &str = "new_diagram";
const QUIT_ID: &str = "quit";
const VAULT_ID: &str = "active_vault";

// Direct-mode windows publish accelerator hints through the frontend. The
// coordinator tray has no editor-local binding cache and leaves these unset.
const TRAY_HOTKEY_COMMANDS: &[(&str, GlobalShortcutCommandId)] = &[
    (NEW_NOTE_ID, GlobalShortcutCommandId::NewMarkdownNote),
    (NEW_DRAWING_ID, GlobalShortcutCommandId::NewDrawing),
    (NEW_INK_ID, GlobalShortcutCommandId::NewInkNote),
];

#[derive(Clone, Debug, Serialize)]
struct TrayNoteCreatedPayload {
    note_id: String,
}

struct TrayMenuItems {
    vault: IconMenuItem<tauri::Wry>,
    vault_label: Mutex<String>,
    new_note: IconMenuItem<tauri::Wry>,
    new_drawing: IconMenuItem<tauri::Wry>,
    new_ink: IconMenuItem<tauri::Wry>,
    new_diagram: IconMenuItem<tauri::Wry>,
    quit: IconMenuItem<tauri::Wry>,
}

pub fn init(app: &App) -> tauri::Result<()> {
    let language_code = app
        .try_state::<DesktopSettings>()
        .map(|settings| settings.language_code())
        .unwrap_or_else(|| "en".to_string());
    let labels = TrayLabels::for_language(&language_code);
    let vault = icon_item(
        app,
        VAULT_ID,
        &labels.no_active_vault,
        false,
        include_bytes!("../icons/tray/vault.png"),
    )?;
    let vault_separator = PredefinedMenuItem::separator(app)?;
    let new_note = icon_item(
        app,
        NEW_NOTE_ID,
        &labels.new_note,
        true,
        include_bytes!("../icons/tray/file-text.png"),
    )?;
    let new_drawing = icon_item(
        app,
        NEW_DRAWING_ID,
        &labels.new_drawing,
        true,
        include_bytes!("../icons/tray/pencil-ruler.png"),
    )?;
    let new_ink = icon_item(
        app,
        NEW_INK_ID,
        &labels.new_ink,
        true,
        include_bytes!("../icons/tray/feather.png"),
    )?;
    let new_diagram = icon_item(
        app,
        NEW_DIAGRAM_ID,
        &labels.new_diagram,
        true,
        include_bytes!("../icons/tray/workflow.png"),
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = icon_item(
        app,
        QUIT_ID,
        &labels.quit,
        true,
        include_bytes!("../icons/tray/log-out.png"),
    )?;
    let menu = Menu::with_items(
        app,
        &[
            &vault,
            &vault_separator,
            &new_note,
            &new_drawing,
            &new_ink,
            &new_diagram,
            &separator,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Mindstream Notes")
        .on_menu_event(|app, event| handle_menu_event(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                if tray
                    .app_handle()
                    .try_state::<crate::vault_supervisor::Host>()
                    .is_some()
                {
                    crate::vault_supervisor::activate(tray.app_handle());
                } else {
                    focus_main_window(tray.app_handle());
                }
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    app.manage(TrayMenuItems {
        vault,
        vault_label: Mutex::new(labels.no_active_vault),
        new_note: new_note.clone(),
        new_drawing: new_drawing.clone(),
        new_ink: new_ink.clone(),
        new_diagram: new_diagram.clone(),
        quit: quit.clone(),
    });

    builder.build(app)?;
    sync_platform_menu(app.handle());
    sync_vault_name(app.handle());
    Ok(())
}

fn icon_item(
    app: &App,
    id: &str,
    label: &str,
    enabled: bool,
    png: &'static [u8],
) -> tauri::Result<IconMenuItem<tauri::Wry>> {
    IconMenuItem::with_id(
        app,
        id,
        label,
        enabled,
        Some(Image::from_bytes(png)?),
        None::<&str>,
    )
}

pub(crate) fn sync_vault_name(app: &AppHandle) {
    let Some(items) = app.try_state::<TrayMenuItems>() else {
        return;
    };
    let name = crate::paths::app_data_root(app)
        .and_then(|root| crate::profiles::load(&root))
        .and_then(|index| match index {
            Some(index) => crate::vault_supervisor::tray_vault_name(app, &index),
            None => Ok(None),
        })
        .unwrap_or_default();
    let language = app
        .try_state::<DesktopSettings>()
        .map(|settings| settings.language_code())
        .unwrap_or_else(|| "en".into());
    let label = name.unwrap_or_else(|| i18n::t_ui(&language, "tray.noActiveVault"));
    // Native menus interpret '&' as a mnemonic. Vault names are literal text.
    let label = label.replace('&', "&&");
    if items
        .vault_label
        .lock()
        .is_ok_and(|previous| *previous == label)
    {
        return;
    }
    // Do not hold a lock while waiting for Tauri's main-thread menu dispatch.
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let Some(items) = handle.try_state::<TrayMenuItems>() else {
            return;
        };
        let Ok(mut previous) = items.vault_label.lock() else {
            return;
        };
        if *previous != label {
            if let Err(error) = items.vault.set_text(&label) {
                log::warn!("[tray] failed to update vault name: {error}");
            } else {
                *previous = label;
                drop(previous);
                sync_platform_menu(&handle);
            }
        }
    }) {
        log::warn!("[tray] failed to schedule vault name update: {error}");
    }
}

pub fn set_language(app: &AppHandle, code: &str) {
    let labels = TrayLabels::for_language(code);
    let Some(items) = app.try_state::<TrayMenuItems>() else {
        return;
    };
    if let Err(err) = items.new_note.set_text(&labels.new_note) {
        log::warn!("[tray] failed to update New note label: {err}");
    }
    if let Err(err) = items.new_drawing.set_text(&labels.new_drawing) {
        log::warn!("[tray] failed to update New drawing canvas label: {err}");
    }
    if let Err(err) = items.new_ink.set_text(&labels.new_ink) {
        log::warn!("[tray] failed to update New handwritten note label: {err}");
    }
    if let Err(err) = items.new_diagram.set_text(&labels.new_diagram) {
        log::warn!("[tray] failed to update New diagram label: {err}");
    }
    if let Err(err) = items.quit.set_text(&labels.quit) {
        log::warn!("[tray] failed to update Quit label: {err}");
    }
    sync_vault_name(app);
    sync_platform_menu(app);
}

pub fn sync_hotkey_displays(app: &AppHandle) {
    let Some(items) = app.try_state::<TrayMenuItems>() else {
        return;
    };

    for (item_id, command_id) in TRAY_HOTKEY_COMMANDS {
        let Some(item) = items.by_id(item_id) else {
            log::warn!("[tray] no tray menu item for hotkey mapping {item_id}");
            continue;
        };
        let accelerator = crate::hotkeys::hotkey_accelerator(app, command_id.hotkey_catalogue_id());
        if let Err(err) = item.set_accelerator(accelerator.as_deref()) {
            log::warn!("[tray] failed to update accelerator for {item_id}: {err}");
        }
    }
    sync_platform_menu(app);
}

fn sync_platform_menu(app: &AppHandle) {
    #[cfg(target_os = "linux")]
    if let Err(error) = linux_menu::sync(app) {
        log::warn!("[tray] failed to update AppIndicator menu: {error}");
    }
    #[cfg(not(target_os = "linux"))]
    let _ = app;
}

fn handle_menu_event(app: &AppHandle, item_id: &str) {
    if item_id == QUIT_ID {
        crate::vault_supervisor::request_quit(app);
        return;
    }

    if app.try_state::<crate::vault_supervisor::Host>().is_some() {
        use crate::shortcut_actions::TrayCommand;
        let action = match item_id {
            NEW_NOTE_ID => Some(TrayCommand::MarkdownNote),
            NEW_DRAWING_ID => Some(TrayCommand::Drawing),
            NEW_INK_ID => Some(TrayCommand::InkNote),
            NEW_DIAGRAM_ID => Some(TrayCommand::Diagram),
            _ => None,
        };
        if let Some(action) = action {
            crate::vault_supervisor::run_tray(app, action);
        }
        return;
    }

    let Some((title, body, note_kind)) = note_template(item_id) else {
        log::warn!("[tray] unhandled menu item {item_id}");
        return;
    };

    create_note_and_emit(app, title, body, note_kind, "tray");
}

pub(crate) fn handle_global_shortcut_command(app: &AppHandle, command_id: GlobalShortcutCommandId) {
    eprintln!(
        "[global-shortcuts] handle_global_shortcut_command command_id={}",
        command_id.hotkey_catalogue_id()
    );
    if command_id == GlobalShortcutCommandId::ShowApp {
        eprintln!("[global-shortcuts] global.showApp -> focus_main_window + emit show-app");
        focus_main_window(app);
        // Mirror the new-note path: the webview-side listener calls
        // focusMainWindow again, which goes through Tauri's main-thread
        // command dispatch. The pure-Rust focus_main_window above runs
        // in the global-shortcut callback thread and on Windows that
        // alone doesn't reliably defeat focus-stealing prevention when
        // the window is hidden in the tray.
        match app.emit(AppEvent::ShowApp.as_str(), ()) {
            Ok(()) => eprintln!("[global-shortcuts] emitted show-app event"),
            Err(err) => eprintln!("[global-shortcuts] failed to emit show-app event: {err}"),
        }
        return;
    }

    let Some((title, body, note_kind)) = global_shortcut_template(command_id) else {
        log::warn!(
            "[global-shortcuts] unhandled command {}",
            command_id.hotkey_catalogue_id()
        );
        return;
    };
    create_note_and_emit(app, title, body, note_kind, "global shortcut");
}

fn create_note_and_emit(
    app: &AppHandle,
    title: &str,
    body: Option<&str>,
    note_kind: NoteKind,
    source: &str,
) {
    let Some(jobs) = app.try_state::<crate::vault_jobs::Jobs>() else {
        log::warn!("[{source}] vault services are unavailable");
        return;
    };
    let Ok(_job) = jobs.enter() else {
        log::warn!("[{source}] vault is closing; note was not created");
        return;
    };
    focus_main_window(app);

    let db = app.state::<Db>();
    let result = db.with_conn(|conn| {
        notes::create(
            conn,
            CreateNote {
                title: Some(title.to_string()),
                body: body.map(str::to_string),
                parent_collection_id: None,
                note_kind: Some(note_kind),
            },
        )
    });

    match result {
        Ok(note) => {
            if let Err(err) = app.emit(
                AppEvent::TrayNoteCreated.as_str(),
                TrayNoteCreatedPayload {
                    note_id: note.summary.id,
                },
            ) {
                log::warn!("[{source}] failed to emit note-created event: {err}");
            }
        }
        Err(err) => log::warn!("[{source}] failed to create note: {err}"),
    }
}

fn note_template(item_id: &str) -> Option<(&'static str, Option<&'static str>, NoteKind)> {
    match item_id {
        NEW_NOTE_ID => Some(("Untitled", None, NoteKind::Markdown)),
        NEW_DRAWING_ID => Some(("Untitled drawing canvas", None, NoteKind::Freeform)),
        NEW_INK_ID => Some(("Untitled handwritten note", None, NoteKind::Ink)),
        NEW_DIAGRAM_ID => Some((
            "Untitled diagram",
            Some("```mermaid\nflowchart TD\n  A[Start] --> B[Next]\n```\n"),
            NoteKind::Markdown,
        )),
        _ => None,
    }
}

fn global_shortcut_template(
    command_id: GlobalShortcutCommandId,
) -> Option<(&'static str, Option<&'static str>, NoteKind)> {
    match command_id {
        GlobalShortcutCommandId::NewMarkdownNote => Some(("Untitled", None, NoteKind::Markdown)),
        GlobalShortcutCommandId::NewDrawing => {
            Some(("Untitled drawing canvas", None, NoteKind::Freeform))
        }
        GlobalShortcutCommandId::NewInkNote => {
            Some(("Untitled handwritten note", None, NoteKind::Ink))
        }
        GlobalShortcutCommandId::ShowApp => None,
    }
}

pub(crate) fn focus_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[focus_main_window] no 'main' window — cannot focus");
        return;
    };
    let visible = window.is_visible().ok();
    let minimized = window.is_minimized().ok();
    let focused = window.is_focused().ok();
    eprintln!(
        "[focus_main_window] entry: visible={visible:?} minimized={minimized:?} focused={focused:?}"
    );
    match window.unminimize() {
        Ok(()) => eprintln!("[focus_main_window] unminimize ok"),
        Err(err) => eprintln!("[focus_main_window] unminimize err={err}"),
    }
    match window.show() {
        Ok(()) => eprintln!("[focus_main_window] show ok"),
        Err(err) => eprintln!("[focus_main_window] show err={err}"),
    }
    match window.set_focus() {
        Ok(()) => eprintln!("[focus_main_window] set_focus ok"),
        Err(err) => eprintln!("[focus_main_window] set_focus err={err}"),
    }
    let visible_after = window.is_visible().ok();
    let minimized_after = window.is_minimized().ok();
    let focused_after = window.is_focused().ok();
    eprintln!(
        "[focus_main_window] exit: visible={visible_after:?} minimized={minimized_after:?} focused={focused_after:?}"
    );
    // Back on screen: take the webview out of low-memory mode now rather
    // than waiting for the focus event, so the first repaint after a tray
    // restore is not the one that pays for it.
    crate::webview_memory::sync_to_visibility(app);
}

pub(crate) fn focus_vault_window(app: &AppHandle, window: &tauri::WebviewWindow) {
    if window.label() == "main" {
        focus_main_window(app);
        return;
    }
    let webview: &tauri::Webview = window.as_ref();
    if let Err(error) = window
        .unminimize()
        .and_then(|_| window.show())
        .and_then(|_| webview.show())
        .and_then(|_| window.set_focus())
        .and_then(|_| webview.set_focus())
    {
        log::warn!("[vaults] note window activation failed: {error}");
    }
}

struct TrayLabels {
    no_active_vault: String,
    new_note: String,
    new_drawing: String,
    new_ink: String,
    new_diagram: String,
    quit: String,
}

impl TrayMenuItems {
    fn by_id(&self, item_id: &str) -> Option<&IconMenuItem<tauri::Wry>> {
        match item_id {
            NEW_NOTE_ID => Some(&self.new_note),
            NEW_DRAWING_ID => Some(&self.new_drawing),
            NEW_INK_ID => Some(&self.new_ink),
            NEW_DIAGRAM_ID => Some(&self.new_diagram),
            QUIT_ID => Some(&self.quit),
            _ => None,
        }
    }
}

impl TrayLabels {
    fn for_language(code: &str) -> Self {
        Self {
            no_active_vault: i18n::t_ui(code, "tray.noActiveVault"),
            new_note: i18n::t_ui(code, "tray.newNote"),
            new_drawing: i18n::t_ui(code, "tray.newDrawing"),
            new_ink: i18n::t_ui(code, "tray.newInk"),
            new_diagram: i18n::t_ui(code, "tray.newDiagram"),
            quit: i18n::t_ui(code, "tray.quit"),
        }
    }
}
