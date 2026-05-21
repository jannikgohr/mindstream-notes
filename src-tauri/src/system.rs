//! Tiny system-introspection commands. Currently just one — `is_appimage_install`
//! — gates the JS-side updater UI from offering an in-app update on Linux
//! installs the Tauri updater plugin can't actually apply (rpm / deb).
//!
//! Background: Tauri 2's `tauri-plugin-updater` Linux backend only knows how
//! to replace an AppImage in place (it overwrites `$APPIMAGE` after
//! verifying the minisign signature). When the user installed via rpm/deb,
//! `$APPIMAGE` is unset, the running binary lives under `/usr/bin/...`, and
//! the plugin currently has no graceful path for that — `downloadAndInstall()`
//! never resolves and the progress dialog hangs in the install phase.
//!
//! Rather than wrestle with that on the JS side with timeouts and partial
//! cleanups, we check up front whether we're an AppImage and short-circuit
//! the updater action otherwise.

#[tauri::command]
pub fn is_appimage_install() -> bool {
    // AppImageLauncher / AppImage's own AppRun wrapper sets two env vars on
    // launch: `APPIMAGE` (the path to the .AppImage file itself) and
    // `APPDIR` (the temp mountpoint). Either one alone is enough proof —
    // `APPIMAGE` is the canonical one consumed by Tauri's updater backend.
    //
    // Non-Linux callers shouldn't be invoking this (the JS gate is
    // Linux-only), but if they do, the env check returns false everywhere
    // except an actual AppImage launch, which is the correct conservative
    // default.
    std::env::var_os("APPIMAGE").is_some()
}
