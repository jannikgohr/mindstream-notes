//! Disposable platform probe. Does not initialize the production app or its DB.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct Probe {
    root: PathBuf,
    vault: String,
    store: String,
    events: Mutex<std::fs::File>,
}

impl Probe {
    fn parse() -> Result<Self, Box<dyn std::error::Error>> {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if args.len() != 6 || args[0] != "--root" || args[2] != "--vault" || args[4] != "--store" {
            return Err("usage: vault_runtime_spike --root ABSOLUTE_DISPOSABLE_DIR --vault a|b --store shared|isolated".into());
        }
        let root = PathBuf::from(&args[1]);
        if !root.is_absolute() || !matches!(args[3].as_str(), "a" | "b") {
            return Err("root must be absolute and vault must be a or b".into());
        }
        if !matches!(args[5].as_str(), "shared" | "isolated") {
            return Err("store must be shared or isolated".into());
        }
        fs::create_dir_all(&root)?;
        let events = OpenOptions::new()
            .create(true)
            .append(true)
            .open(root.join(format!("{}-events.jsonl", args[3])))?;
        Ok(Self {
            root,
            vault: args[3].clone(),
            store: args[5].clone(),
            events: Mutex::new(events),
        })
    }

    fn record(&self, event: &str, payload: Value) -> Result<(), String> {
        let mut file = self.events.lock().map_err(|err| err.to_string())?;
        let record = json!({
            "event": event,
            "payload": payload,
            "pid": std::process::id(),
            "vault": self.vault,
            "at": chrono::Utc::now().to_rfc3339(),
        });
        writeln!(file, "{record}").map_err(|err| err.to_string())?;
        file.flush().map_err(|err| err.to_string())
    }
}

fn create_window(app: &tauri::AppHandle, label: &str) -> tauri::Result<()> {
    let probe = app.state::<Probe>();
    let store_name = if probe.store == "shared" {
        "shared"
    } else {
        &probe.vault
    };
    let configuration = json!({ "vault": probe.vault, "label": label, "store": probe.store });
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(format!("Vault spike {}: {label}", probe.vault))
        .inner_size(660.0, 420.0)
        .position(if probe.vault == "a" { 80.0 } else { 760.0 }, 100.0)
        .initialization_script(format!("window.__SPIKE__ = {configuration};"))
        .additional_browser_args("--renderer-process-limit=1");
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    let builder = builder.data_directory(probe.root.join("webview").join(store_name));
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    let builder = {
        use sha2::{Digest, Sha256};
        // Stable for every window/restart of this disposable store. The API is
        // available only on macOS >=14; older OS behavior is a spike question.
        let hash = Sha256::digest(format!("{}:{store_name}", probe.root.display()).as_bytes());
        let mut identifier = [0u8; 16];
        identifier.copy_from_slice(&hash[..16]);
        builder.data_store_identifier(identifier)
    };
    let window = builder.build()?;
    #[cfg(target_os = "windows")]
    {
        let handle = app.clone();
        let label = window.label().to_string();
        window.with_webview(move |webview| {
            // Runs on the WebView thread. The COM out-pointer lives until the
            // synchronous call returns, and the controller owns the interface.
            let result = unsafe {
                webview.controller().CoreWebView2().and_then(|core| {
                    let mut pid = 0;
                    core.BrowserProcessId(&mut pid)?;
                    Ok(pid)
                })
            };
            let payload = match result {
                Ok(pid) => json!({ "label": label, "browserPid": pid }),
                Err(err) => json!({ "label": label, "error": err.to_string() }),
            };
            let _ = handle.state::<Probe>().record("browser", payload);
        })?;
    }
    #[cfg(not(target_os = "windows"))]
    let _ = window;
    Ok(())
}

#[tauri::command]
fn spike_report(
    probe: tauri::State<'_, Probe>,
    event: String,
    payload: Value,
) -> Result<(), String> {
    probe.record(&event, payload)
}

#[tauri::command]
async fn spike_popout(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("popout") {
        return window.set_focus().map_err(|err| err.to_string());
    }
    create_window(&app, "popout").map_err(|err| err.to_string())
}

#[tauri::command]
fn spike_exit(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let probe = Probe::parse()?;
    probe.record(
        "launch",
        json!({ "store": probe.store, "os": std::env::consts::OS }),
    )?;
    let app = tauri::Builder::default()
        .manage(probe)
        .invoke_handler(tauri::generate_handler![
            spike_report,
            spike_popout,
            spike_exit
        ])
        .setup(|app| {
            create_window(app.handle(), "main")?;
            Ok(())
        })
        .on_window_event(|window, event| {
            let _ = window.app_handle().state::<Probe>().record(
                "window",
                json!({
                    "label": window.label(), "event": format!("{event:?}")
                }),
            );
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!(
            "spikes/vault-runtime/tauri.conf.json"
        ))?;
    app.run(|app, event| {
        if matches!(
            event,
            tauri::RunEvent::MainEventsCleared | tauri::RunEvent::WindowEvent { .. }
        ) {
            return;
        }
        let _ = app
            .state::<Probe>()
            .record("lifecycle", json!({ "event": format!("{event:?}") }));
    });
    Ok(())
}
