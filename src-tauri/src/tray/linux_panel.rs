//! The desktop portal's colour scheme, the best available guess at whether
//! the panel is dark. Tauri only forwards theme changes on Windows.

use std::{
    sync::atomic::{AtomicU32, Ordering},
    time::Duration,
};

use dbus::{arg::Variant, blocking::Connection, message::MatchRule};
use tauri::AppHandle;

const NAMESPACE: &str = "org.freedesktop.appearance";
const KEY: &str = "color-scheme";
const PREFER_LIGHT: u32 = 2;

/// Filled in by the watcher thread so the main thread never waits on D-Bus.
static SCHEME: AtomicU32 = AtomicU32::new(0);

/// GNOME reports "no preference" (0) for its light style, but its top bar
/// stays dark, so only an explicit light preference means a light panel.
pub(super) fn is_dark() -> bool {
    SCHEME.load(Ordering::Relaxed) != PREFER_LIGHT
}

pub(super) fn watch(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("tray-colour-scheme".into())
        .spawn(move || {
            if let Err(error) = listen(app) {
                log::info!("[tray] colour scheme is unavailable: {error}");
            }
        });
    if let Err(error) = spawned {
        log::warn!("[tray] failed to watch the colour scheme: {error}");
    }
}

fn listen(app: AppHandle) -> Result<(), dbus::Error> {
    let connection = Connection::new_session()?;
    let handle = app.clone();
    let rule = MatchRule::new_signal("org.freedesktop.portal.Settings", "SettingChanged");
    connection.add_match(rule, move |(): (), _, message| {
        let mut args = message.iter_init();
        if args.read::<&str>().ok() == Some(NAMESPACE) && args.read::<&str>().ok() == Some(KEY) {
            if let Ok(value) = args.read::<Variant<u32>>() {
                adopt(&handle, value.0);
            }
        }
        true
    })?;
    let proxy = connection.with_proxy(
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        Duration::from_secs(5),
    );
    // `Read` is the older call every portal version has; it wraps the value twice.
    // A portal that is slow to start can still send changes later.
    match proxy.method_call::<(Variant<Variant<u32>>,), _, _, _>(
        "org.freedesktop.portal.Settings",
        "Read",
        (NAMESPACE, KEY),
    ) {
        Ok((value,)) => adopt(&app, value.0 .0),
        Err(error) => log::info!("[tray] colour scheme is not known yet: {error}"),
    }
    loop {
        connection.process(Duration::from_secs(3600))?;
    }
}

fn adopt(app: &AppHandle, scheme: u32) {
    if SCHEME.swap(scheme, Ordering::Relaxed) != scheme {
        super::refresh_icon(app);
    }
}
