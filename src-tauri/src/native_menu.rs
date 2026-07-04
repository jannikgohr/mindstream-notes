use serde::Serialize;
use tauri::{
    menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu},
    App, AppHandle, Emitter, EventTarget, Manager,
};

use crate::{desktop_settings::DesktopSettings, i18n};

const COMMAND_EVENT: &str = "native-menu-command";
const ID_SETTINGS: &str = "native:app:settings";
const ID_QUIT: &str = "native:app:quit";
const ID_NEW_NOTE: &str = "native:file:new-note";
const ID_NEW_DRAWING: &str = "native:file:new-drawing";
const ID_NEW_INK: &str = "native:file:new-ink";
const ID_IMPORT_PDF: &str = "native:file:import-pdf";
const ID_UNDO: &str = "native:edit:undo";
const ID_REDO: &str = "native:edit:redo";
const ID_CUT: &str = "native:edit:cut";
const ID_COPY: &str = "native:edit:copy";
const ID_PASTE: &str = "native:edit:paste";
const ID_SELECT_ALL: &str = "native:edit:select-all";
const ID_TOGGLE_SIDEBAR: &str = "native:view:toggle-sidebar";
const ID_TOGGLE_METADATA: &str = "native:view:toggle-metadata";
const ID_SEARCH_NOTES: &str = "native:view:search-notes";
const ID_THEME_LIGHT: &str = "native:view:theme-light";
const ID_THEME_DARK: &str = "native:view:theme-dark";
const ID_THEME_SYSTEM: &str = "native:view:theme-system";
const ID_CLOSE_WINDOW: &str = "native:window:close";
const ID_MAIN_WINDOW: &str = "native:window:main";
const ID_SHOW_SHORTCUTS: &str = "native:help:shortcuts";
const WINDOW_ITEM_PREFIX: &str = "native:window:";

#[derive(Debug, Clone, Serialize)]
struct NativeMenuCommandPayload {
    command: &'static str,
}

pub fn init(app: &App) -> tauri::Result<()> {
    rebuild(app.handle())
}

pub fn rebuild(app: &AppHandle) -> tauri::Result<()> {
    let language_code = app
        .try_state::<DesktopSettings>()
        .map(|settings| settings.language_code())
        .unwrap_or_else(|| "en".to_string());
    let labels = NativeMenuLabels::for_language(&language_code);
    let menu = build_menu(app, &labels)?;
    app.set_menu(menu)?;
    Ok(())
}

pub fn set_language(app: &AppHandle) {
    if let Err(err) = rebuild(app) {
        log::warn!("[native-menu] failed to rebuild menu: {err}");
    }
}

pub fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    let item_id = event.id().as_ref();
    match item_id {
        ID_QUIT => app.exit(0),
        ID_CLOSE_WINDOW => close_focused_window(app),
        ID_MAIN_WINDOW => crate::tray::focus_main_window(app),
        _ if item_id.starts_with(WINDOW_ITEM_PREFIX) => {
            focus_window(app, item_id.trim_start_matches(WINDOW_ITEM_PREFIX));
        }
        _ => {
            if let Some(command) = command_for_item(item_id) {
                emit_command_to_focused_window(app, command);
            }
        }
    }
}

pub fn refresh_window_menu(app: &AppHandle) {
    if let Err(err) = rebuild(app) {
        log::warn!("[native-menu] failed to refresh window menu: {err}");
    }
}

fn build_menu(app: &AppHandle, labels: &NativeMenuLabels) -> tauri::Result<Menu<tauri::Wry>> {
    let app_menu = build_app_menu(app, labels)?;
    let file_menu = build_file_menu(app, labels)?;
    let edit_menu = build_edit_menu(app, labels)?;
    let view_menu = build_view_menu(app, labels)?;
    let window_menu = build_window_menu(app, labels)?;
    let help_menu = build_help_menu(app, labels)?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

fn build_app_menu(
    app: &AppHandle,
    labels: &NativeMenuLabels,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let about_metadata = AboutMetadata {
        name: Some("Mindstream Notes".to_string()),
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        copyright: Some("Copyright © 2026 Jannik Gohr".to_string()),
        ..Default::default()
    };
    let about = PredefinedMenuItem::about(app, Some(&labels.about), Some(about_metadata))?;
    let settings = item(app, ID_SETTINGS, &labels.settings, Some("CmdOrCtrl+,"))?;
    let services = PredefinedMenuItem::services(app, Some(&labels.services))?;
    let hide = PredefinedMenuItem::hide(app, Some(&labels.hide))?;
    let hide_others = PredefinedMenuItem::hide_others(app, Some(&labels.hide_others))?;
    let show_all = PredefinedMenuItem::show_all(app, Some(&labels.show_all))?;
    let quit = item(app, ID_QUIT, &labels.quit, Some("CmdOrCtrl+Q"))?;
    let separator = PredefinedMenuItem::separator(app)?;
    let separator_2 = PredefinedMenuItem::separator(app)?;
    let separator_3 = PredefinedMenuItem::separator(app)?;
    let separator_4 = PredefinedMenuItem::separator(app)?;

    Submenu::with_items(
        app,
        &labels.app,
        true,
        &[
            &about,
            &separator,
            &settings,
            &separator_2,
            &services,
            &separator_3,
            &hide,
            &hide_others,
            &show_all,
            &separator_4,
            &quit,
        ],
    )
}

fn build_file_menu(
    app: &AppHandle,
    labels: &NativeMenuLabels,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let new_note = item(app, ID_NEW_NOTE, &labels.new_note, Some("CmdOrCtrl+Alt+N"))?;
    let new_drawing = item(
        app,
        ID_NEW_DRAWING,
        &labels.new_drawing,
        Some("CmdOrCtrl+Alt+D"),
    )?;
    let new_ink = item(app, ID_NEW_INK, &labels.new_ink, Some("CmdOrCtrl+Alt+I"))?;
    let import_pdf = item(app, ID_IMPORT_PDF, &labels.import_pdf, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;

    Submenu::with_items(
        app,
        &labels.file,
        true,
        &[&new_note, &new_drawing, &new_ink, &separator, &import_pdf],
    )
}

fn build_edit_menu(
    app: &AppHandle,
    labels: &NativeMenuLabels,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let undo = item(app, ID_UNDO, &labels.undo, Some("CmdOrCtrl+Z"))?;
    let redo = item(app, ID_REDO, &labels.redo, Some("CmdOrCtrl+Shift+Z"))?;
    let cut = item(app, ID_CUT, &labels.cut, Some("CmdOrCtrl+X"))?;
    let copy = item(app, ID_COPY, &labels.copy, Some("CmdOrCtrl+C"))?;
    let paste = item(app, ID_PASTE, &labels.paste, Some("CmdOrCtrl+V"))?;
    let select_all = item(app, ID_SELECT_ALL, &labels.select_all, Some("CmdOrCtrl+A"))?;
    let separator = PredefinedMenuItem::separator(app)?;

    Submenu::with_items(
        app,
        &labels.edit,
        true,
        &[&undo, &redo, &separator, &cut, &copy, &paste, &select_all],
    )
}

fn build_view_menu(
    app: &AppHandle,
    labels: &NativeMenuLabels,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let toggle_sidebar = item(app, ID_TOGGLE_SIDEBAR, &labels.toggle_sidebar, None::<&str>)?;
    let toggle_metadata = item(
        app,
        ID_TOGGLE_METADATA,
        &labels.toggle_metadata,
        None::<&str>,
    )?;
    let search_notes = item(
        app,
        ID_SEARCH_NOTES,
        &labels.search_notes,
        Some("CmdOrCtrl+Shift+F"),
    )?;
    let theme_light = item(app, ID_THEME_LIGHT, &labels.theme_light, None::<&str>)?;
    let theme_dark = item(app, ID_THEME_DARK, &labels.theme_dark, None::<&str>)?;
    let theme_system = item(app, ID_THEME_SYSTEM, &labels.theme_system, None::<&str>)?;
    let theme_menu = Submenu::with_items(
        app,
        &labels.theme,
        true,
        &[&theme_light, &theme_dark, &theme_system],
    )?;
    let separator = PredefinedMenuItem::separator(app)?;

    Submenu::with_items(
        app,
        &labels.view,
        true,
        &[
            &toggle_sidebar,
            &toggle_metadata,
            &search_notes,
            &separator,
            &theme_menu,
        ],
    )
}

fn build_window_menu(
    app: &AppHandle,
    labels: &NativeMenuLabels,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let close = item(
        app,
        ID_CLOSE_WINDOW,
        &labels.close_window,
        Some("CmdOrCtrl+W"),
    )?;
    let minimize = PredefinedMenuItem::minimize(app, Some(&labels.minimize))?;
    let zoom = PredefinedMenuItem::maximize(app, Some(&labels.zoom))?;
    let bring_all_to_front =
        PredefinedMenuItem::bring_all_to_front(app, Some(&labels.bring_all_to_front))?;
    let main_window = item(app, ID_MAIN_WINDOW, &labels.main_window, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let separator_2 = PredefinedMenuItem::separator(app)?;

    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = vec![
        Box::new(close),
        Box::new(minimize),
        Box::new(zoom),
        Box::new(separator),
        Box::new(bring_all_to_front),
        Box::new(separator_2),
        Box::new(main_window),
    ];

    for entry in open_note_windows(app) {
        items.push(Box::new(item(
            app,
            format!("{WINDOW_ITEM_PREFIX}{}", entry.label),
            entry.title,
            None::<&str>,
        )?));
    }

    let item_refs = items
        .iter()
        .map(|item| item.as_ref())
        .collect::<Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>>>();
    Submenu::with_items(app, &labels.window, true, &item_refs)
}

fn build_help_menu(
    app: &AppHandle,
    labels: &NativeMenuLabels,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let shortcuts = item(
        app,
        ID_SHOW_SHORTCUTS,
        &labels.keyboard_shortcuts,
        Some("Ctrl+Shift+/"),
    )?;
    Submenu::with_items(app, &labels.help, true, &[&shortcuts])
}

fn item<I, S, A>(
    app: &AppHandle,
    id: I,
    text: S,
    accelerator: Option<A>,
) -> tauri::Result<MenuItem<tauri::Wry>>
where
    I: Into<tauri::menu::MenuId>,
    S: AsRef<str>,
    A: AsRef<str>,
{
    MenuItem::with_id(app, id, text, true, accelerator)
}

fn command_for_item(item_id: &str) -> Option<&'static str> {
    match item_id {
        ID_SETTINGS => Some("open-settings"),
        ID_NEW_NOTE => Some("new-markdown-note"),
        ID_NEW_DRAWING => Some("new-drawing"),
        ID_NEW_INK => Some("new-ink-note"),
        ID_IMPORT_PDF => Some("import-pdf"),
        ID_UNDO => Some("undo"),
        ID_REDO => Some("redo"),
        ID_CUT => Some("cut"),
        ID_COPY => Some("copy"),
        ID_PASTE => Some("paste"),
        ID_SELECT_ALL => Some("select-all"),
        ID_TOGGLE_SIDEBAR => Some("toggle-sidebar"),
        ID_TOGGLE_METADATA => Some("toggle-metadata"),
        ID_SEARCH_NOTES => Some("search-notes"),
        ID_THEME_LIGHT => Some("theme-light"),
        ID_THEME_DARK => Some("theme-dark"),
        ID_THEME_SYSTEM => Some("theme-system"),
        ID_SHOW_SHORTCUTS => Some("show-keyboard-shortcuts"),
        _ => None,
    }
}

fn emit_command_to_focused_window(app: &AppHandle, command: &'static str) {
    let payload = NativeMenuCommandPayload { command };
    if let Some(window) = focused_window(app) {
        if let Err(err) = app.emit_to(
            EventTarget::webview_window(window.label()),
            COMMAND_EVENT,
            payload,
        ) {
            log::warn!("[native-menu] failed to emit {command}: {err}");
        }
        return;
    }
    if let Err(err) = app.emit_to(EventTarget::webview_window("main"), COMMAND_EVENT, payload) {
        log::warn!("[native-menu] failed to emit {command} to main: {err}");
    }
}

fn close_focused_window(app: &AppHandle) {
    let Some(window) = focused_window(app).or_else(|| app.get_webview_window("main")) else {
        return;
    };
    if window.label() == "main" {
        let _ = window.hide();
    } else if let Err(err) = window.close() {
        log::warn!("[native-menu] failed to close {}: {err}", window.label());
    }
}

fn focus_window(app: &AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
}

fn focused_window(app: &AppHandle) -> Option<tauri::WebviewWindow<tauri::Wry>> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
}

struct WindowEntry {
    label: String,
    title: String,
}

fn open_note_windows(app: &AppHandle) -> Vec<WindowEntry> {
    let mut entries = app
        .webview_windows()
        .into_iter()
        .filter_map(|(label, window)| {
            if label == "main" {
                return None;
            }
            let title = window.title().unwrap_or_else(|_| "Note".to_string());
            Some(WindowEntry { label, title })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    entries
}

struct NativeMenuLabels {
    app: String,
    about: String,
    settings: String,
    services: String,
    hide: String,
    hide_others: String,
    show_all: String,
    quit: String,
    file: String,
    new_note: String,
    new_drawing: String,
    new_ink: String,
    import_pdf: String,
    edit: String,
    undo: String,
    redo: String,
    cut: String,
    copy: String,
    paste: String,
    select_all: String,
    view: String,
    toggle_sidebar: String,
    toggle_metadata: String,
    search_notes: String,
    theme: String,
    theme_light: String,
    theme_dark: String,
    theme_system: String,
    window: String,
    close_window: String,
    minimize: String,
    zoom: String,
    bring_all_to_front: String,
    main_window: String,
    help: String,
    keyboard_shortcuts: String,
}

impl NativeMenuLabels {
    fn for_language(code: &str) -> Self {
        Self {
            app: "Mindstream Notes".to_string(),
            about: i18n::t_ui(code, "nativeMenu.app.about"),
            settings: i18n::t_ui(code, "nativeMenu.app.settings"),
            services: i18n::t_ui(code, "nativeMenu.app.services"),
            hide: i18n::t_ui(code, "nativeMenu.app.hide"),
            hide_others: i18n::t_ui(code, "nativeMenu.app.hideOthers"),
            show_all: i18n::t_ui(code, "nativeMenu.app.showAll"),
            quit: i18n::t_ui(code, "nativeMenu.app.quit"),
            file: i18n::t_ui(code, "nativeMenu.file"),
            new_note: i18n::t_ui(code, "nativeMenu.file.newNote"),
            new_drawing: i18n::t_ui(code, "nativeMenu.file.newDrawing"),
            new_ink: i18n::t_ui(code, "nativeMenu.file.newInk"),
            import_pdf: i18n::t_ui(code, "nativeMenu.file.importPdf"),
            edit: i18n::t_ui(code, "nativeMenu.edit"),
            undo: i18n::t_ui(code, "nativeMenu.edit.undo"),
            redo: i18n::t_ui(code, "nativeMenu.edit.redo"),
            cut: i18n::t_ui(code, "nativeMenu.edit.cut"),
            copy: i18n::t_ui(code, "nativeMenu.edit.copy"),
            paste: i18n::t_ui(code, "nativeMenu.edit.paste"),
            select_all: i18n::t_ui(code, "nativeMenu.edit.selectAll"),
            view: i18n::t_ui(code, "nativeMenu.view"),
            toggle_sidebar: i18n::t_ui(code, "nativeMenu.view.toggleSidebar"),
            toggle_metadata: i18n::t_ui(code, "nativeMenu.view.toggleMetadata"),
            search_notes: i18n::t_ui(code, "nativeMenu.view.searchNotes"),
            theme: i18n::t_ui(code, "nativeMenu.view.theme"),
            theme_light: i18n::t_ui(code, "nativeMenu.view.themeLight"),
            theme_dark: i18n::t_ui(code, "nativeMenu.view.themeDark"),
            theme_system: i18n::t_ui(code, "nativeMenu.view.themeSystem"),
            window: i18n::t_ui(code, "nativeMenu.window"),
            close_window: i18n::t_ui(code, "nativeMenu.window.close"),
            minimize: i18n::t_ui(code, "nativeMenu.window.minimize"),
            zoom: i18n::t_ui(code, "nativeMenu.window.zoom"),
            bring_all_to_front: i18n::t_ui(code, "nativeMenu.window.bringAllToFront"),
            main_window: i18n::t_ui(code, "nativeMenu.window.main"),
            help: i18n::t_ui(code, "nativeMenu.help"),
            keyboard_shortcuts: i18n::t_ui(code, "nativeMenu.help.keyboardShortcuts"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_for_item_maps_frontend_commands() {
        let cases = [
            (ID_SETTINGS, "open-settings"),
            (ID_NEW_NOTE, "new-markdown-note"),
            (ID_NEW_DRAWING, "new-drawing"),
            (ID_NEW_INK, "new-ink-note"),
            (ID_IMPORT_PDF, "import-pdf"),
            (ID_UNDO, "undo"),
            (ID_REDO, "redo"),
            (ID_CUT, "cut"),
            (ID_COPY, "copy"),
            (ID_PASTE, "paste"),
            (ID_SELECT_ALL, "select-all"),
            (ID_TOGGLE_SIDEBAR, "toggle-sidebar"),
            (ID_TOGGLE_METADATA, "toggle-metadata"),
            (ID_SEARCH_NOTES, "search-notes"),
            (ID_THEME_LIGHT, "theme-light"),
            (ID_THEME_DARK, "theme-dark"),
            (ID_THEME_SYSTEM, "theme-system"),
            (ID_SHOW_SHORTCUTS, "show-keyboard-shortcuts"),
        ];

        for (item_id, command) in cases {
            assert_eq!(command_for_item(item_id), Some(command));
        }
    }

    #[test]
    fn command_for_item_leaves_rust_owned_menu_items_in_rust() {
        assert_eq!(command_for_item(ID_QUIT), None);
        assert_eq!(command_for_item(ID_CLOSE_WINDOW), None);
        assert_eq!(command_for_item(ID_MAIN_WINDOW), None);
        assert_eq!(command_for_item("native:window:note-123"), None);
        assert_eq!(command_for_item("native:unknown"), None);
    }

    #[test]
    fn window_item_prefix_matches_window_focus_ids() {
        assert_eq!(WINDOW_ITEM_PREFIX, "native:window:");
        assert!(format!("{WINDOW_ITEM_PREFIX}note-123").starts_with(WINDOW_ITEM_PREFIX));
    }
}
