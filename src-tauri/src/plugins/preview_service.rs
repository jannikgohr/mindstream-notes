//! Long-lived **preview services** for plugins — a declared PATH binary the host
//! runs as a *persistent local server* (unlike the one-shot
//! [`super::run_native_tool_process`]) and exposes to a plugin note's preview
//! iframe. The motivating case is `tinymist preview`, which serves an
//! incremental-SVG frontend on an HTTP "data plane" port and a bidirectional
//! "control plane" WebSocket (click-to-source / cursor-follow).
//!
//! The host owns the whole lifecycle: it allocates the ports (so nothing has to
//! parse version-sensitive startup logs), materializes the note body to an
//! absolute temp `.typ` file the server watches, spawns the process, waits for
//! the data port to accept connections, and keeps the child in a registry keyed
//! by a caller-supplied session id (one per open note) so it can be stopped when
//! the note closes and reaped on exit. Everything is gated on the
//! `nativeServices.run` permission and is **desktop-only**.

use std::collections::HashMap;
use std::io::Write;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::db::Db;
use crate::error::{AppError, AppResult, CommandResult};

use super::discovery;

const PERM_NATIVE_SERVICES_RUN: &str = "nativeServices.run";
/// How long we wait for the server to start accepting connections on its data port.
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// A plugin-declared preview service, parsed from `contributes.nativeServices`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginNativeServiceManifest {
    id: String,
    /// Exact executable basename resolved from PATH (no path/shell).
    binary_name: String,
    /// Argument template. Placeholders `{dataPort}`, `{controlPort}`, `{input}`
    /// are substituted per launch.
    args: Vec<String>,
    /// URL template the iframe loads, e.g. `http://127.0.0.1:{dataPort}`.
    data_url: String,
    /// Control-plane URL template, e.g. `ws://127.0.0.1:{controlPort}`.
    control_url: String,
    /// File extension for the materialized input (default `typ`).
    #[serde(default)]
    input_extension: Option<String>,
}

/// One running preview server.
struct Session {
    child: Child,
    input_path: PathBuf,
}

impl Session {
    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // Best-effort cleanup of the materialized source file.
        let _ = std::fs::remove_file(&self.input_path);
    }
}

/// App-lifetime registry of running preview servers, keyed by session id.
#[derive(Default)]
pub struct PreviewServiceRegistry {
    sessions: Mutex<HashMap<String, Session>>,
}

impl PreviewServiceRegistry {
    /// Reap every running server. Called on app exit so nothing is orphaned.
    pub fn shutdown_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, mut session) in sessions.drain() {
                session.kill();
            }
        }
    }
}

/// What `plugins_preview_start` returns to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewServiceHandle {
    pub session_key: String,
    pub data_url: String,
    pub control_url: String,
}

/// Availability of a declared service's binary (does it resolve on PATH?).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewServiceStatus {
    pub service_id: String,
    pub binary_name: String,
    pub available: bool,
    pub path: Option<String>,
}

fn parse_services(manifest: &serde_json::Value) -> AppResult<Vec<PluginNativeServiceManifest>> {
    let Some(value) = manifest
        .get("contributes")
        .and_then(|c| c.get("nativeServices"))
    else {
        return Ok(Vec::new());
    };
    serde_json::from_value(value.clone())
        .map_err(|e| AppError::InvalidArg(format!("manifest.contributes.nativeServices: {e}")))
}

fn find_service(
    manifest: &serde_json::Value,
    service_id: &str,
) -> AppResult<PluginNativeServiceManifest> {
    parse_services(manifest)?
        .into_iter()
        .find(|s| s.id == service_id)
        .ok_or_else(|| AppError::NotFound(format!("plugin preview service {service_id}")))
}

/// Grab a currently-free localhost TCP port by binding `:0` and releasing it.
/// There's a small race before the child rebinds it, accepted as standard.
fn free_port() -> AppResult<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

fn substitute(template: &str, data_port: u16, control_port: u16, input: &str) -> String {
    template
        .replace("{dataPort}", &data_port.to_string())
        .replace("{controlPort}", &control_port.to_string())
        .replace("{input}", input)
}

/// Poll the data port until the server accepts a connection or we time out.
fn wait_until_ready(port: u16) -> AppResult<()> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let deadline = Instant::now() + READY_TIMEOUT;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err(AppError::InvalidArg(
        "preview service did not start listening in time".into(),
    ))
}

/// Sanitize a session id into a safe filename stem (kept short + alnum).
fn safe_stem(session_key: &str) -> String {
    let stem: String = session_key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(64)
        .collect();
    if stem.is_empty() {
        "session".into()
    } else {
        stem
    }
}

#[tauri::command]
pub fn plugins_native_service_status(
    app: AppHandle,
    db: State<'_, Db>,
    id: String,
    service_id: String,
) -> CommandResult<PreviewServiceStatus> {
    db.with_conn(|c| super::require_enabled_permission(c, &id, PERM_NATIVE_SERVICES_RUN))?;
    let third_party_dir = discovery::third_party_plugins_dir(&app)?;
    let plugin = discovery::find(&third_party_dir, &id)
        .ok_or_else(|| AppError::NotFound(format!("plugin {id} not found on disk")))?;
    let service = find_service(&plugin.manifest, &service_id)?;
    // Desktop-only: report unavailable on mobile rather than erroring.
    if cfg!(mobile) {
        return Ok(PreviewServiceStatus {
            service_id,
            binary_name: service.binary_name,
            available: false,
            path: None,
        });
    }
    let path = super::resolve_path_binary(&service.binary_name)?;
    Ok(PreviewServiceStatus {
        service_id,
        binary_name: service.binary_name,
        available: path.is_some(),
        path: path.map(|p| p.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
pub async fn plugins_preview_start(
    app: AppHandle,
    db: State<'_, Db>,
    registry: State<'_, PreviewServiceRegistry>,
    id: String,
    service_id: String,
    session_key: String,
    input: String,
) -> CommandResult<PreviewServiceHandle> {
    if cfg!(mobile) {
        return Err(AppError::InvalidArg("preview services are desktop-only".into()).into());
    }
    db.with_conn(|c| super::require_enabled_permission(c, &id, PERM_NATIVE_SERVICES_RUN))?;

    let third_party_dir = discovery::third_party_plugins_dir(&app)?;
    let plugin = discovery::find(&third_party_dir, &id)
        .ok_or_else(|| AppError::NotFound(format!("plugin {id} not found on disk")))?;
    let service = find_service(&plugin.manifest, &service_id)?;

    let binary = super::resolve_path_binary(&service.binary_name)?.ok_or_else(|| {
        AppError::NotFound(format!(
            "preview service binary '{}' was not found in PATH",
            service.binary_name
        ))
    })?;

    let cwd = super::plugin_data_root(&app, &id)?;
    let preview_dir = cwd.join("preview");
    std::fs::create_dir_all(&preview_dir)?;
    let ext = service.input_extension.as_deref().unwrap_or("typ");
    let input_path = preview_dir.join(format!("{}.{ext}", safe_stem(&session_key)));

    // Stop any prior server for this session before starting a fresh one.
    stop_session(&registry, &session_key);

    let handle = tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&input_path, input.as_bytes())?;
        let input_str = input_path.to_string_lossy().into_owned();
        let data_port = free_port()?;
        let control_port = free_port()?;
        let args: Vec<String> = service
            .args
            .iter()
            .map(|a| substitute(a, data_port, control_port, &input_str))
            .collect();
        let child = Command::new(&binary)
            .args(&args)
            .current_dir(&cwd)
            .spawn()?;
        let data_url = substitute(&service.data_url, data_port, control_port, &input_str);
        let control_url = substitute(&service.control_url, data_port, control_port, &input_str);
        let mut session = Session { child, input_path };
        if let Err(e) = wait_until_ready(data_port) {
            session.kill();
            return Err(e);
        }
        Ok((session, data_url, control_url))
    })
    .await
    .map_err(|e| AppError::InvalidArg(format!("preview service task failed: {e}")))??;

    let (session, data_url, control_url) = handle;
    registry
        .sessions
        .lock()
        .map_err(|_| AppError::InvalidArg("preview registry poisoned".into()))?
        .insert(session_key.clone(), session);

    Ok(PreviewServiceHandle {
        session_key,
        data_url,
        control_url,
    })
}

/// Rewrite the materialized source file so the watching server recompiles.
#[tauri::command]
pub async fn plugins_preview_update(
    registry: State<'_, PreviewServiceRegistry>,
    session_key: String,
    input: String,
) -> CommandResult<()> {
    let path = {
        let sessions = registry
            .sessions
            .lock()
            .map_err(|_| AppError::InvalidArg("preview registry poisoned".into()))?;
        sessions.get(&session_key).map(|s| s.input_path.clone())
    };
    let Some(path) = path else {
        return Ok(()); // session already gone; nothing to update
    };
    // Write atomically-ish (truncate + write) off the async runtime.
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let mut file = std::fs::File::create(&path)?;
        file.write_all(input.as_bytes())?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::InvalidArg(format!("preview update task failed: {e}")))??;
    Ok(())
}

fn stop_session(registry: &PreviewServiceRegistry, session_key: &str) {
    if let Ok(mut sessions) = registry.sessions.lock() {
        if let Some(mut session) = sessions.remove(session_key) {
            session.kill();
        }
    }
}

#[tauri::command]
pub async fn plugins_preview_stop(
    registry: State<'_, PreviewServiceRegistry>,
    session_key: String,
) -> CommandResult<()> {
    stop_session(&registry, &session_key);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitutes_all_placeholders() {
        let out = substitute(
            "preview --data-plane-host 127.0.0.1:{dataPort} --control-plane-host 127.0.0.1:{controlPort} {input}",
            4001,
            4002,
            "C:/x/doc.typ",
        );
        assert_eq!(
            out,
            "preview --data-plane-host 127.0.0.1:4001 --control-plane-host 127.0.0.1:4002 C:/x/doc.typ"
        );
    }

    #[test]
    fn free_ports_are_distinct_and_bindable() {
        let a = free_port().unwrap();
        let b = free_port().unwrap();
        assert!(a > 0 && b > 0);
        // Both should be bindable right after being reported free.
        TcpListener::bind((Ipv4Addr::LOCALHOST, a)).unwrap();
    }

    #[test]
    fn safe_stem_strips_unsafe_chars() {
        assert_eq!(safe_stem("plugin/../note id!"), "plugin..noteid");
        assert_eq!(safe_stem(""), "session");
    }

    #[test]
    fn find_service_reads_manifest() {
        let manifest = serde_json::json!({
            "contributes": { "nativeServices": [{
                "id": "tinymist",
                "binaryName": "tinymist",
                "args": ["preview", "{input}"],
                "dataUrl": "http://127.0.0.1:{dataPort}",
                "controlUrl": "ws://127.0.0.1:{controlPort}"
            }]}
        });
        let svc = find_service(&manifest, "tinymist").unwrap();
        assert_eq!(svc.binary_name, "tinymist");
        assert!(find_service(&manifest, "ghost").is_err());
    }
}
