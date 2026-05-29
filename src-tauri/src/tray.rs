use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager,
};

use crate::{
    db::Db,
    desktop_settings::DesktopSettings,
    drawing,
    notes::{self, CreateNote},
};

const TRAY_NOTE_CREATED_EVENT: &str = "tray-note-created";
const NEW_NOTE_ID: &str = "new_note";
const NEW_DRAWING_ID: &str = "new_drawing";
const NEW_DIAGRAM_ID: &str = "new_diagram";
const QUIT_ID: &str = "quit";

#[derive(Clone, Debug, Serialize)]
struct TrayNoteCreatedPayload {
    note_id: String,
}

struct TrayMenuItems {
    new_note: MenuItem<tauri::Wry>,
    new_drawing: MenuItem<tauri::Wry>,
    new_diagram: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

pub fn init(app: &App) -> tauri::Result<()> {
    let labels = tray_labels(
        &app.try_state::<DesktopSettings>()
            .map(|settings| settings.language_code())
            .unwrap_or_else(|| "en".to_string()),
    );
    let new_note = MenuItem::with_id(app, NEW_NOTE_ID, labels.new_note, true, None::<&str>)?;
    let new_drawing =
        MenuItem::with_id(app, NEW_DRAWING_ID, labels.new_drawing, true, None::<&str>)?;
    let new_diagram =
        MenuItem::with_id(app, NEW_DIAGRAM_ID, labels.new_diagram, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, QUIT_ID, labels.quit, true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&new_note, &new_drawing, &new_diagram, &separator, &quit],
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
        new_diagram: new_diagram.clone(),
        quit: quit.clone(),
    });

    builder.build(app)?;
    Ok(())
}

pub fn set_language(app: &AppHandle, code: &str) {
    let labels = tray_labels(code);
    let Some(items) = app.try_state::<TrayMenuItems>() else {
        return;
    };
    if let Err(err) = items.new_note.set_text(labels.new_note) {
        log::warn!("[tray] failed to update New note label: {err}");
    }
    if let Err(err) = items.new_drawing.set_text(labels.new_drawing) {
        log::warn!("[tray] failed to update New drawing label: {err}");
    }
    if let Err(err) = items.new_diagram.set_text(labels.new_diagram) {
        log::warn!("[tray] failed to update New diagram label: {err}");
    }
    if let Err(err) = items.quit.set_text(labels.quit) {
        log::warn!("[tray] failed to update Quit label: {err}");
    }
}

fn handle_menu_event(app: &AppHandle, item_id: &str) {
    if item_id == QUIT_ID {
        drawing::shutdown_desktop(app);
        app.exit(0);
        return;
    }

    let Some((title, body, note_kind)) = note_template(item_id) else {
        log::warn!("[tray] unhandled menu item {item_id}");
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
                log::warn!("[tray] failed to emit note-created event: {err}");
            }
        }
        Err(err) => log::warn!("[tray] failed to create note from tray: {err}"),
    }
}

fn note_template(item_id: &str) -> Option<(&'static str, Option<&'static str>, &'static str)> {
    match item_id {
        NEW_NOTE_ID => Some(("Untitled", None, "markdown")),
        NEW_DRAWING_ID => Some(("Untitled drawing", None, "freeform")),
        NEW_DIAGRAM_ID => Some((
            "Untitled diagram",
            Some("```mermaid\nflowchart TD\n  A[Start] --> B[Next]\n```\n"),
            "markdown",
        )),
        _ => None,
    }
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

struct TrayLabels {
    new_note: &'static str,
    new_drawing: &'static str,
    new_diagram: &'static str,
    quit: &'static str,
}

fn tray_labels(code: &str) -> TrayLabels {
    match code {
        "de" => TrayLabels {
            new_note: "Neue Notiz",
            new_drawing: "Neue Zeichnung",
            new_diagram: "Neues Diagramm",
            quit: "Beenden",
        },
        _ => TrayLabels {
            new_note: "New note",
            new_drawing: "New drawing",
            new_diagram: "New diagram",
            quit: "Quit",
        },
    }
}
