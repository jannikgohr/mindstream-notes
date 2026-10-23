use super::*;
use crate::{db, environment, hotkeys, paths, profiles, vault_jobs};

fn snapshot(app: &AppHandle) -> muda::Menu {
    build_menu(app, menu_rows(app, &app.state::<TrayMenuItems>()).unwrap())
}

fn entries(menu: &muda::Menu) -> Vec<gtk::MenuItem> {
    menu.gtk_context_menu()
        .children()
        .into_iter()
        .map(|child| child.downcast::<gtk::MenuItem>().unwrap())
        .collect()
}

#[test]
#[cfg_attr(
    not(coverage),
    ignore = "requires a display; run with xvfb-run -a cargo test native_tray_menu -- --ignored"
)]
fn native_tray_menu_exports_icons_accelerators_actions_and_renamed_vault() {
    let root = tempfile::tempdir().unwrap();
    let index = profiles::load_or_init(root.path()).unwrap();
    let other = profiles::add_profile(root.path(), "Other vault").unwrap();
    profiles::set_active(root.path(), &other.id).unwrap();
    let app = tauri::Builder::default()
        .any_thread()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(environment::Environment {
        kind: environment::Kind::Test,
        root: root.path().to_path_buf(),
        credential_service: "native-tray-menu-test".into(),
    });
    app.manage(paths::ActiveProfile {
        id: index.active.clone(),
        dir: profiles::profile_dir(root.path(), &index.active),
    });
    app.manage(db::open_memory_for_tests());
    app.manage(vault_jobs::Jobs::default());
    app.manage(hotkeys::NativeHotkeyDisplays::default());

    // With no tray registered, refresh is harmless. Initializing a real tray
    // then exercises the same AppIndicator installation path as the app.
    sync(app.handle()).unwrap();
    crate::tray::init(&app).unwrap();
    hotkeys::set_hotkey_displays(
        app.handle().clone(),
        app.state(),
        serde_json::from_value(serde_json::json!([
            {"commandId":"global.newMarkdownNote", "accelerator":"CommandOrControl+Alt+N"},
            {"commandId":"global.newDrawing", "accelerator":"Control+Shift+D"},
            {"commandId":"global.newInkNote", "accelerator":"CmdOrCtrl+Super+I"}
        ]))
        .unwrap(),
    )
    .unwrap();

    let menu = snapshot(app.handle());
    let items = entries(&menu);
    assert_eq!(items.len(), 8);
    assert!(!items[0].is_sensitive());
    assert_eq!(items[0].label().as_deref(), Some("Default"));
    assert!(items[1].is::<gtk::SeparatorMenuItem>());
    assert!(items[6].is::<gtk::SeparatorMenuItem>());
    assert_eq!(items[7].label().as_deref(), Some("Quit"));
    for item in items
        .iter()
        .filter(|item| !item.is::<gtk::SeparatorMenuItem>())
    {
        assert!(item.property::<bool>("always-show-image"));
        let image = item.property::<gtk::Image>("image");
        let pixbuf = image.pixbuf().unwrap();
        assert_eq!((pixbuf.width(), pixbuf.height()), (16, 16));
    }
    let accelerator = items[2]
        .child()
        .unwrap()
        .downcast::<gtk::AccelLabel>()
        .unwrap();
    assert_eq!(accelerator.accel().0, u32::from(b'n'));
    assert!(accelerator
        .accel()
        .1
        .contains(gtk::gdk::ModifierType::CONTROL_MASK));
    assert!(accelerator
        .accel()
        .1
        .contains(gtk::gdk::ModifierType::MOD1_MASK));

    // Activating the exported GTK items must reach the real capture handlers.
    for item in &items[2..6] {
        assert!(item.is_sensitive());
        item.emit_activate();
    }
    let kinds: Vec<String> = app
        .state::<db::Db>()
        .with_conn(|conn| {
            Ok(conn
                .prepare("SELECT note_kind FROM notes ORDER BY note_kind")?
                .query_map([], |row| row.get(0))?
                .collect::<Result<_, _>>()?)
        })
        .unwrap();
    assert_eq!(kinds, ["freeform", "ink", "markdown", "markdown"]);

    let renamed = profiles::rename_profile(
        app.handle().clone(),
        index.active.clone(),
        " Research & notes ".into(),
    )
    .unwrap();
    assert_eq!(renamed.name, "Research & notes");
    assert_eq!(
        entries(&snapshot(app.handle()))[0].label().as_deref(),
        Some("Research & notes")
    );
    assert_eq!(
        profiles::load(root.path()).unwrap().unwrap().profiles[0].name,
        "Research & notes"
    );
    profiles::rename_profile(app.handle().clone(), other.id, "Other renamed".into()).unwrap();
    assert_eq!(
        entries(&snapshot(app.handle()))[0].label().as_deref(),
        Some("Research & notes")
    );
    assert!(profiles::rename_profile(app.handle().clone(), index.active, "  ".into()).is_err());
    assert_eq!(
        entries(&snapshot(app.handle()))[0].label().as_deref(),
        Some("Research & notes")
    );

    crate::tray::set_language(app.handle(), "de");
    assert_eq!(
        entries(&snapshot(app.handle()))[2].label().as_deref(),
        Some("Neue Notiz")
    );
    let tray = app.remove_tray_by_id(TRAY_ID).unwrap();
    sync(app.handle()).unwrap();
    drop(tray);
}
