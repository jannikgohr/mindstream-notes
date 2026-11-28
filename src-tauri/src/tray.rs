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
    desktop_settings::{DesktopSettings, TrayIconStyle},
    environment::{self, Kind},
    hotkeys::GlobalShortcutCommandId,
    i18n,
    notes::{self, CreateNote, NoteKind},
};

#[cfg(target_os = "linux")]
mod linux_menu;
#[cfg(target_os = "linux")]
mod linux_panel;

const TRAY_ID: &str = "main-tray";
const NEW_NOTE_ID: &str = "new_note";
const NEW_DRAWING_ID: &str = "new_drawing";
const NEW_INK_ID: &str = "new_ink";
const NEW_DIAGRAM_ID: &str = "new_diagram";
const QUIT_ID: &str = "quit";
const VAULT_ID: &str = "active_vault";
const DEV_ID: &str = "dev_environment";
const DEV_NAME: &str = "Mindstream Notes Dev";
const MONOCHROME_LIGHT: &[u8] = include_bytes!("../icons/tray/app-light.png");
const MONOCHROME_DARK: &[u8] = include_bytes!("../icons/tray/app-dark.png");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrayArt {
    Color,
    Light,
    Dark,
    /// macOS tints a template image to match the menu bar.
    Template,
}

/// Only Linux has to guess the panel colour: its tray shows the image as is.
fn tray_art(style: TrayIconStyle, os: &str, dark_panel: impl FnOnce() -> bool) -> TrayArt {
    match style {
        TrayIconStyle::Color => TrayArt::Color,
        TrayIconStyle::MonochromeLight => TrayArt::Light,
        TrayIconStyle::MonochromeDark => TrayArt::Dark,
        TrayIconStyle::Automatic => match os {
            "macos" => TrayArt::Template,
            "linux" if dark_panel() => TrayArt::Light,
            "linux" => TrayArt::Dark,
            _ => TrayArt::Color,
        },
    }
}

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

/// Notes made from the tray or a global shortcut that the main window has not
/// opened yet. It may still be loading when one is made: at launch, or when
/// it is built again after `worker_shutdown::unload_main_window`.
#[derive(Default)]
pub struct CreatedNotes(Mutex<Vec<String>>);

/// Keep a new note for the main window and tell it to come and get it.
pub(crate) fn note_created(app: &AppHandle, note_id: String) -> tauri::Result<()> {
    if let Some(notes) = app.try_state::<CreatedNotes>() {
        notes
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(note_id.clone());
    }
    app.emit_to(
        "main",
        AppEvent::TrayNoteCreated.as_str(),
        TrayNoteCreatedPayload { note_id },
    )
}

/// The notes made from the tray or a shortcut since the window last asked.
/// It asks when it starts and again whenever it is told one was made.
#[tauri::command]
pub fn take_created_notes(notes: tauri::State<'_, CreatedNotes>) -> Vec<String> {
    std::mem::take(
        &mut *notes
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
    )
}

struct TrayMenuItems {
    #[cfg(target_os = "linux")]
    dev: Option<IconMenuItem<tauri::Wry>>,
    vault: IconMenuItem<tauri::Wry>,
    vault_label: Mutex<String>,
    new_note: IconMenuItem<tauri::Wry>,
    new_drawing: IconMenuItem<tauri::Wry>,
    new_ink: IconMenuItem<tauri::Wry>,
    new_diagram: IconMenuItem<tauri::Wry>,
    quit: IconMenuItem<tauri::Wry>,
    art: Mutex<Option<TrayArt>>,
}

pub fn init(app: &App) -> tauri::Result<()> {
    let kind = app
        .try_state::<environment::Environment>()
        .map(|environment| environment.kind)
        .unwrap_or_else(environment::kind);
    let icon = app
        .default_window_icon()
        .map(|icon| tray_icon(icon, kind, false));
    let dev = if kind == Kind::Dev {
        Some(IconMenuItem::with_id(
            app,
            DEV_ID,
            DEV_NAME,
            false,
            icon.clone(),
            None::<&str>,
        )?)
    } else {
        None
    };
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
    if let Some(dev) = &dev {
        menu.prepend(&PredefinedMenuItem::separator(app)?)?;
        menu.prepend(dev)?;
    }

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(if kind == Kind::Dev {
            DEV_NAME
        } else {
            "Mindstream Notes"
        })
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

    let style = app
        .try_state::<DesktopSettings>()
        .map(|settings| settings.tray_icon())
        .unwrap_or_default();
    let art = tray_art(style, std::env::consts::OS, panel_is_dark);
    if let Some(icon) = tray_image(app.handle(), art, kind) {
        builder = builder
            .icon(icon)
            .icon_as_template(art == TrayArt::Template);
    }

    app.manage(TrayMenuItems {
        #[cfg(target_os = "linux")]
        dev,
        vault,
        vault_label: Mutex::new(labels.no_active_vault),
        new_note: new_note.clone(),
        new_drawing: new_drawing.clone(),
        new_ink: new_ink.clone(),
        new_diagram: new_diagram.clone(),
        quit: quit.clone(),
        art: Mutex::new(Some(art)),
    });

    builder.build(app)?;
    #[cfg(target_os = "linux")]
    linux_panel::watch(app.handle().clone());
    sync_platform_menu(app.handle());
    sync_vault_name(app.handle());
    Ok(())
}

fn panel_is_dark() -> bool {
    #[cfg(target_os = "linux")]
    return linux_panel::is_dark();
    #[cfg(not(target_os = "linux"))]
    true
}

fn tray_image(app: &AppHandle, art: TrayArt, kind: Kind) -> Option<Image<'static>> {
    let base = match art {
        TrayArt::Color => app.default_window_icon()?.clone(),
        TrayArt::Light => Image::from_bytes(MONOCHROME_LIGHT).ok()?,
        TrayArt::Dark | TrayArt::Template => Image::from_bytes(MONOCHROME_DARK).ok()?,
    };
    Some(tray_icon(&base, kind, art == TrayArt::Template))
}

/// Settings changes and Linux colour scheme changes both land here.
pub fn set_icon_style(app: &AppHandle, style: TrayIconStyle) {
    let Some(items) = app.try_state::<TrayMenuItems>() else {
        return;
    };
    let art = tray_art(style, std::env::consts::OS, panel_is_dark);
    // Not held while Tauri dispatches the change to the main thread.
    match items.art.lock() {
        Ok(mut applied) if *applied != Some(art) => *applied = Some(art),
        _ => return,
    }
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let kind = app
        .try_state::<environment::Environment>()
        .map(|environment| environment.kind)
        .unwrap_or_else(environment::kind);
    if let Err(error) =
        tray.set_icon_with_as_template(tray_image(app, art, kind), art == TrayArt::Template)
    {
        log::warn!("[tray] failed to update icon: {error}");
        if let Ok(mut applied) = items.art.lock() {
            *applied = None;
        }
    }
}

#[cfg(target_os = "linux")]
fn refresh_icon(app: &AppHandle) {
    let handle = app.clone();
    let scheduled = app.run_on_main_thread(move || {
        if let Some(settings) = handle.try_state::<DesktopSettings>() {
            set_icon_style(&handle, settings.tray_icon());
        }
    });
    if let Err(error) = scheduled {
        log::warn!("[tray] failed to schedule icon update: {error}");
    }
}

/// A template image keeps only alpha, so the badge letter is cut out of it.
fn tray_icon(icon: &Image<'_>, kind: Kind, template: bool) -> Image<'static> {
    let mut rgba = icon.rgba().to_vec();
    if kind == Kind::Dev {
        // Draw an amber D badge in the bottom-right corner, using a 32px grid
        // so the mark scales with the platform's default window icon.
        let letter = [
            0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110,
        ];
        for y in 0..icon.height() {
            for x in 0..icon.width() {
                let bx = x * 32 / icon.width();
                let by = y * 32 / icon.height();
                if bx < 18 || by < 18 {
                    continue;
                }
                let is_letter = (22..27).contains(&bx)
                    && (21..28).contains(&by)
                    && letter[(by - 21) as usize] & (1 << (26 - bx)) != 0;
                let color = if is_letter && template {
                    [0, 0, 0, 0]
                } else if is_letter {
                    [24, 24, 24, 255]
                } else {
                    [245, 158, 11, 255]
                };
                let offset = ((y * icon.width() + x) * 4) as usize;
                rgba[offset..offset + 4].copy_from_slice(&color);
            }
        }
    }
    Image::new_owned(rgba, icon.width(), icon.height())
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
    // The window just focused shows the running import.
    if let Err(err) = crate::import::refuse_while_importing(app) {
        log::info!("[{source}] {err}");
        return;
    }

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
            if let Err(err) = note_created(app, note.summary.id) {
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
    let window = app
        .get_webview_window("main")
        .or_else(|| crate::reload_main_window(app));
    let Some(window) = window else {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_dev_tray_icons_get_a_badge() {
        for size in [16, 32, 128, 512] {
            let icon = Image::new_owned(vec![255; size * size * 4], size as u32, size as u32);
            for kind in [Kind::Release, Kind::Test] {
                assert_eq!(tray_icon(&icon, kind, false).rgba(), icon.rgba());
            }
            let dev = tray_icon(&icon, Kind::Dev, false);
            assert_eq!((dev.width(), dev.height()), (icon.width(), icon.height()));
            let pixel = |x: usize, y: usize| {
                let offset = (y * size / 32 * size + x * size / 32) * 4;
                &dev.rgba()[offset..offset + 4]
            };
            assert_eq!(pixel(0, 0), [255; 4]);
            assert_eq!(pixel(16, 24), [255; 4]);
            assert_eq!(pixel(30, 30), [245, 158, 11, 255]);
            assert_eq!(pixel(22, 24), [24, 24, 24, 255]);
            let template = tray_icon(&icon, Kind::Dev, true);
            let offset = (24 * size / 32 * size + 22 * size / 32) * 4;
            assert_eq!(template.rgba()[offset + 3], 0);
        }
    }

    #[test]
    fn automatic_tray_icon_follows_the_platform_and_choices_override_it() {
        let unasked = || -> bool { panic!("only Linux guesses the panel colour") };
        assert_eq!(
            tray_art(TrayIconStyle::Automatic, "windows", unasked),
            TrayArt::Color
        );
        assert_eq!(
            tray_art(TrayIconStyle::Automatic, "macos", unasked),
            TrayArt::Template
        );
        assert_eq!(
            tray_art(TrayIconStyle::Automatic, "linux", || true),
            TrayArt::Light
        );
        assert_eq!(
            tray_art(TrayIconStyle::Automatic, "linux", || false),
            TrayArt::Dark
        );
        for os in ["windows", "macos", "linux"] {
            assert_eq!(tray_art(TrayIconStyle::Color, os, unasked), TrayArt::Color);
            assert_eq!(
                tray_art(TrayIconStyle::MonochromeLight, os, unasked),
                TrayArt::Light
            );
            assert_eq!(
                tray_art(TrayIconStyle::MonochromeDark, os, unasked),
                TrayArt::Dark
            );
        }
    }
}
