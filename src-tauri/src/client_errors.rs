/// Persist uncaught frontend failures through the same logger as backend errors.
#[tauri::command]
pub fn report_client_error(message: String) {
    let bounded: String = message.chars().take(4096).collect();
    log::error!("[client] {}", bounded.replace(['\r', '\n'], " "));
}
