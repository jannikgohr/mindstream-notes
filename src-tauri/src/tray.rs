use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager,
};

use crate::{
    db::Db,
    desktop_settings::DesktopSettings,
    i18n,
    notes::{self, CreateNote},
};

const TRAY_NOTE_CREATED_EVENT: &str = "tray-note-created";
const SHOW_APP_EVENT: &str = "show-app";
const NEW_NOTE_ID: &str = "new_note";
const NEW_DRAWING_ID: &str = "new_drawing";
const NEW_INK_ID: &str = "new_ink";
const NEW_DIAGRAM_ID: &str = "new_diagram";
const QUIT_ID: &str = "quit";

// Tray item id -> hotkey command id. The JS side owns bindings; Rust only
// mirrors their native accelerator strings into the tray menu.
const TRAY_HOTKEY_COMMANDS: &[(&str, &str)] = &[
    (NEW_NOTE_ID, "global.newMarkdownNote"),
    (NEW_DRAWING_ID, "global.newDrawing"),
    (NEW_INK_ID, "global.newInkNote"),
];

#[derive(Clone, Debug, Serialize)]
struct TrayNoteCreatedPayload {
    note_id: String,
}

struct TrayMenuItems {
    new_note: MenuItem<tauri::Wry>,
    new_drawing: MenuItem<tauri::Wry>,
    new_ink: MenuItem<tauri::Wry>,
    new_diagram: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

pub fn init(app: &App) -> tauri::Result<()> {
    let language_code = app
        .try_state::<DesktopSettings>()
        .map(|settings| settings.language_code())
        .unwrap_or_else(|| "en".to_string());
    let labels = TrayLabels::for_language(&language_code);
    let new_note = MenuItem::with_id(app, NEW_NOTE_ID, &labels.new_note, true, None::<&str>)?;
    let new_drawing =
        MenuItem::with_id(app, NEW_DRAWING_ID, &labels.new_drawing, true, None::<&str>)?;
    let new_ink = MenuItem::with_id(app, NEW_INK_ID, &labels.new_ink, true, None::<&str>)?;
    let new_diagram =
        MenuItem::with_id(app, NEW_DIAGRAM_ID, &labels.new_diagram, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, QUIT_ID, &labels.quit, true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &new_note,
            &new_drawing,
            &new_ink,
            &new_diagram,
            &separator,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::new()
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
                focus_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    app.manage(TrayMenuItems {
        new_note: new_note.clone(),
        new_drawing: new_drawing.clone(),
        new_ink: new_ink.clone(),
        new_diagram: new_diagram.clone(),
        quit: quit.clone(),
    });

    builder.build(app)?;
    Ok(())
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
        log::warn!("[tray] failed to update New drawing label: {err}");
    }
    if let Err(err) = items.new_ink.set_text(&labels.new_ink) {
        log::warn!("[tray] failed to update New ink note label: {err}");
    }
    if let Err(err) = items.new_diagram.set_text(&labels.new_diagram) {
        log::warn!("[tray] failed to update New diagram label: {err}");
    }
    if let Err(err) = items.quit.set_text(&labels.quit) {
        log::warn!("[tray] failed to update Quit label: {err}");
    }
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
        let accelerator = crate::hotkeys::hotkey_accelerator(app, command_id);
        if let Err(err) = item.set_accelerator(accelerator.as_deref()) {
            log::warn!("[tray] failed to update accelerator for {item_id}: {err}");
        }
    }
}

fn handle_menu_event(app: &AppHandle, item_id: &str) {
    if item_id == QUIT_ID {
        app.exit(0);
        return;
    }

    let Some((title, body, note_kind)) = note_template(item_id) else {
        log::warn!("[tray] unhandled menu item {item_id}");
        return;
    };

    create_note_and_emit(app, title, body, note_kind, "tray");
}

pub(crate) fn handle_global_shortcut_command(app: &AppHandle, command_id: &str) {
    eprintln!("[global-shortcuts] handle_global_shortcut_command command_id={command_id}");
    if command_id == "global.showApp" {
        eprintln!("[global-shortcuts] global.showApp -> focus_main_window + emit show-app");
        focus_main_window(app);
        // Mirror the new-note path: the webview-side listener calls
        // focusMainWindow again, which goes through Tauri's main-thread
        // command dispatch. The pure-Rust focus_main_window above runs
        // in the global-shortcut callback thread and on Windows that
        // alone doesn't reliably defeat focus-stealing prevention when
        // the window is hidden in the tray.
        match app.emit(SHOW_APP_EVENT, ()) {
            Ok(()) => eprintln!("[global-shortcuts] emitted show-app event"),
            Err(err) => eprintln!("[global-shortcuts] failed to emit show-app event: {err}"),
        }
        return;
    }

    let Some((title, body, note_kind)) = global_shortcut_template(command_id) else {
        log::warn!("[global-shortcuts] unhandled command {command_id}");
        return;
    };
    create_note_and_emit(app, title, body, note_kind, "global shortcut");
}

fn create_note_and_emit(
    app: &AppHandle,
    title: &str,
    body: Option<&str>,
    note_kind: &str,
    source: &str,
) {
    focus_main_window(app);

    let db = app.state::<Db>();
    let result = db.with_conn(|conn| {
        notes::create(
            conn,
            CreateNote {
                title: Some(title.to_string()),
                body: body.map(str::to_string),
                parent_collection_id: None,
                note_kind: Some(note_kind.to_string()),
            },
        )
    });

    match result {
        Ok(note) => {
            if let Err(err) = app.emit(
                TRAY_NOTE_CREATED_EVENT,
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

fn note_template(item_id: &str) -> Option<(&'static str, Option<&'static str>, &'static str)> {
    match item_id {
        NEW_NOTE_ID => Some(("Untitled", None, "markdown")),
        NEW_DRAWING_ID => Some(("Untitled drawing", None, "freeform")),
        NEW_INK_ID => Some(("Untitled ink note", None, "ink")),
        NEW_DIAGRAM_ID => Some((
            "Untitled diagram",
            Some("```mermaid\nflowchart TD\n  A[Start] --> B[Next]\n```\n"),
            "markdown",
        )),
        _ => None,
    }
}

fn global_shortcut_template(
    command_id: &str,
) -> Option<(&'static str, Option<&'static str>, &'static str)> {
    match command_id {
        "global.newMarkdownNote" => Some(("Untitled", None, "markdown")),
        "global.newDrawing" => Some(("Untitled drawing", None, "freeform")),
        "global.newInkNote" => Some(("Untitled ink note", None, "ink")),
        _ => None,
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
}

struct TrayLabels {
    new_note: String,
    new_drawing: String,
    new_ink: String,
    new_diagram: String,
    quit: String,
}

impl TrayMenuItems {
    fn by_id(&self, item_id: &str) -> Option<&MenuItem<tauri::Wry>> {
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
            new_note: i18n::t_ui(code, "tray.newNote"),
            new_drawing: i18n::t_ui(code, "tray.newDrawing"),
            new_ink: i18n::t_ui(code, "tray.newInk"),
            new_diagram: i18n::t_ui(code, "tray.newDiagram"),
            quit: i18n::t_ui(code, "tray.quit"),
        }
    }
}
