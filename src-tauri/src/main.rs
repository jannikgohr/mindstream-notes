// Prevents an extra console window from opening on Windows in release mode.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri_note_taking_app_lib::run()
}
