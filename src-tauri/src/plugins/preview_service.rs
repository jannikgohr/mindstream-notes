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

use std::borrow::Cow;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::db::Db;
use crate::error::{AppError, AppResult, CommandResult};

use super::discovery;

const PERM_NATIVE_SERVICES_RUN: &str = "nativeServices.run";
/// How long we wait for the server to start accepting connections on its data port.
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_PLUGIN_PREVIEW_CSS_BYTES: usize = 64 * 1024;

/// The custom URI scheme our preview reverse-proxy is served under (see
/// [`proxy_preview_html`]). Registered in `lib.rs`.
pub const PREVIEW_SCHEME: &str = "msn-preview";

/// Permissive CSP for the *proxied* preview document only (its own origin, not
/// the app's). The upstream frontend is a single self-contained file that runs
/// inlined scripts + WASM and talks to loopback sockets, so we allow exactly
/// that and nothing that could reach off-device.
const PROXY_CSP: &str = "default-src 'none'; \
     script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; \
     style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; \
     connect-src ws://127.0.0.1:* http://127.0.0.1:* data: blob:; \
     worker-src blob:; base-uri 'none'";

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum PreviewIframeMode {
    Direct,
    Themed,
}

fn default_preview_iframe_mode() -> PreviewIframeMode {
    PreviewIframeMode::Direct
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewIframeManifest {
    #[serde(default = "default_preview_iframe_mode")]
    mode: PreviewIframeMode,
    css: Option<String>,
    /// Default WebSocket port the tool's own frontend hardcodes as a fallback
    /// (tinymist uses 23625). When set (themed mode only), the host injects a
    /// generic shim that redirects a socket opened to `127.0.0.1:<port>` to this
    /// proxy origin instead, so it tunnels back to the real server. `None` = the
    /// frontend derives its socket from `location` and no shim is needed.
    #[serde(default)]
    socket_rewrite_port: Option<u16>,
}

impl Default for PreviewIframeManifest {
    fn default() -> Self {
        Self {
            mode: PreviewIframeMode::Direct,
            css: None,
            socket_rewrite_port: None,
        }
    }
}

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
    #[serde(default)]
    preview_iframe: PreviewIframeManifest,
}

/// One running preview server.
struct Session {
    child: Child,
    input_path: PathBuf,
    /// The server's data-plane HTTP port — where the reverse-proxy fetches the
    /// frontend HTML from.
    data_port: u16,
    proxy: Option<LoopbackPreviewProxy>,
}

impl Session {
    fn kill(&mut self) {
        if let Some(proxy) = self.proxy.take() {
            proxy.shutdown();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        // Best-effort cleanup of the materialized source file.
        let _ = std::fs::remove_file(&self.input_path);
    }
}

struct LoopbackPreviewProxy {
    port: u16,
    styles: PreviewProxyStyles,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

#[derive(Clone, Default)]
struct PreviewProxyStyles {
    plugin_css: Option<String>,
    /// See [`PreviewIframeManifest::socket_rewrite_port`]. Drives the injected
    /// WebSocket shim; `None` injects no shim.
    socket_rewrite_port: Option<u16>,
}

impl LoopbackPreviewProxy {
    fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn shutdown(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect((Ipv4Addr::LOCALHOST, self.port));
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
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

    /// The data port and styles for a themed proxy session, if any. Used by the
    /// reverse proxy to validate that a request targets an opt-in themed session
    /// rather than an arbitrary loopback port.
    fn themed_proxy(&self, session_key: &str) -> Option<(u16, PreviewProxyStyles)> {
        let sessions = self.sessions.lock().ok()?;
        let session = sessions.get(session_key)?;
        session
            .proxy
            .as_ref()
            .map(|proxy| (session.data_port, proxy.styles.clone()))
    }
}

/// What `plugins_preview_start` returns to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewServiceHandle {
    pub session_key: String,
    pub data_url: String,
    pub control_url: String,
    pub proxy_url: Option<String>,
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

fn substitute(
    template: &str,
    data_port: u16,
    control_port: u16,
    input: &str,
    settings: &HashMap<String, String>,
) -> String {
    let mut out = template
        .replace("{dataPort}", &data_port.to_string())
        .replace("{controlPort}", &control_port.to_string())
        .replace("{input}", input);
    // `{setting:<id>}` is resolved from a snapshot of the plugin's own settings
    // the frontend passes at launch (values are persisted in web storage, so the
    // backend can't read them itself). This lets a launch flag be a user toggle
    // — e.g. tinymist's `--partial-rendering {setting:partial-rendering}`.
    for (key, value) in settings {
        out = out.replace(&format!("{{setting:{key}}}"), value);
    }
    out
}

/// Restrict a settings-derived arg value to a safe CLI charset. These values come
/// from a plugin's own settings snapshot (booleans / enum ids), never shell
/// input, but constrain them regardless: alphanumerics plus a few separators, no
/// leading dash (so a value can't masquerade as a flag), and length-capped.
fn sanitize_setting_value(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '+'))
        .take(64)
        .collect();
    cleaned.trim_start_matches('-').to_string()
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

fn is_safe_preview_css_path(path: &str) -> bool {
    !path.is_empty()
        && path.ends_with(".css")
        && !path.contains("..")
        && !path.contains('\\')
        && !path.starts_with('/')
        && path.split('/').all(|segment| {
            let mut chars = segment.chars();
            matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
                && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        })
}

fn sanitize_plugin_preview_css(css: &str) -> AppResult<String> {
    if css.len() > MAX_PLUGIN_PREVIEW_CSS_BYTES {
        return Err(AppError::InvalidArg(format!(
            "preview iframe css is too large (max {MAX_PLUGIN_PREVIEW_CSS_BYTES} bytes)"
        )));
    }
    let lower = css.to_ascii_lowercase();
    let unsafe_tokens = [
        "</style",
        "<script",
        "@import",
        "javascript:",
        "expression(",
    ];
    if css.contains('\0') || unsafe_tokens.iter().any(|token| lower.contains(token)) {
        return Err(AppError::InvalidArg(
            "preview iframe css contains unsafe tokens".into(),
        ));
    }
    Ok(css.to_string())
}

fn load_plugin_preview_css(
    files: &discovery::PluginFiles,
    path: Option<&str>,
) -> AppResult<Option<String>> {
    let Some(path) = path else {
        return Ok(None);
    };
    if !is_safe_preview_css_path(path) {
        return Err(AppError::InvalidArg(format!(
            "preview iframe css path '{path}' must be a safe relative .css file"
        )));
    }
    let Some(css) = files.read_text(path)? else {
        return Err(AppError::NotFound(format!("preview iframe css {path}")));
    };
    sanitize_plugin_preview_css(&css).map(Some)
}

fn start_loopback_proxy(
    data_port: u16,
    styles: PreviewProxyStyles,
) -> AppResult<LoopbackPreviewProxy> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let thread_styles = Arc::new(styles.clone());
    let join = thread::spawn(move || {
        for incoming in listener.incoming() {
            if thread_stop.load(Ordering::Relaxed) {
                break;
            }
            let Ok(stream) = incoming else {
                continue;
            };
            let conn_stop = Arc::clone(&thread_stop);
            let conn_styles = Arc::clone(&thread_styles);
            thread::spawn(move || {
                if !conn_stop.load(Ordering::Relaxed) {
                    handle_proxy_connection(stream, data_port, &conn_styles);
                }
            });
        }
    });
    Ok(LoopbackPreviewProxy {
        port,
        styles,
        stop,
        join: Some(join),
    })
}

fn handle_proxy_connection(mut client: TcpStream, data_port: u16, styles: &PreviewProxyStyles) {
    let Ok(request) = read_http_head(&mut client) else {
        return;
    };
    if request.is_empty() {
        return;
    }
    if is_websocket_upgrade(&request) {
        tunnel_websocket(client, request, data_port);
    } else {
        serve_proxied_html(client, request, data_port, styles);
    }
}

fn read_http_head(stream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0_u8; 1024];
    while buf.len() < 64 * 1024 {
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    Ok(buf)
}

fn is_websocket_upgrade(request: &[u8]) -> bool {
    let text = String::from_utf8_lossy(request);
    text.lines().any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.starts_with("upgrade:") && lower.contains("websocket")
    })
}

fn tunnel_websocket(mut client: TcpStream, request: Vec<u8>, data_port: u16) {
    let Ok(mut upstream) = TcpStream::connect((Ipv4Addr::LOCALHOST, data_port)) else {
        write_simple_response(
            &mut client,
            502,
            "Bad Gateway",
            "preview websocket unavailable",
        );
        return;
    };
    let rewritten = rewrite_ws_handshake(&request, data_port);
    if upstream.write_all(rewritten.as_bytes()).is_err() {
        return;
    }

    let Ok(mut upstream_to_client) = upstream.try_clone() else {
        return;
    };
    let Ok(mut client_to_upstream) = client.try_clone() else {
        return;
    };
    let a = thread::spawn(move || {
        let _ = std::io::copy(&mut client_to_upstream, &mut upstream);
        let _ = upstream.shutdown(Shutdown::Write);
    });
    let b = thread::spawn(move || {
        let _ = std::io::copy(&mut upstream_to_client, &mut client);
        let _ = client.shutdown(Shutdown::Write);
    });
    let _ = a.join();
    let _ = b.join();
}

fn rewrite_ws_handshake(request: &[u8], data_port: u16) -> String {
    let text = String::from_utf8_lossy(request);
    let upstream_origin = format!("http://127.0.0.1:{data_port}");
    let upstream_host = format!("127.0.0.1:{data_port}");
    let mut out = String::new();
    for line in text.split("\r\n") {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("host:") {
            out.push_str("Host: ");
            out.push_str(&upstream_host);
        } else if lower.starts_with("origin:") {
            out.push_str("Origin: ");
            out.push_str(&upstream_origin);
        } else {
            out.push_str(line);
        }
        out.push_str("\r\n");
        if line.is_empty() {
            break;
        }
    }
    out
}

fn serve_proxied_html(
    mut client: TcpStream,
    request: Vec<u8>,
    data_port: u16,
    styles: &PreviewProxyStyles,
) {
    let bg = sanitize_css_color(&query_param_from_request(&request, "bg").unwrap_or_default());
    let fg = sanitize_css_color(&query_param_from_request(&request, "fg").unwrap_or_default());
    let gutter =
        sanitize_css_length(&query_param_from_request(&request, "gutter").unwrap_or_default());
    let scrollbar =
        sanitize_css_color(&query_param_from_request(&request, "scrollbar").unwrap_or_default());
    match fetch_upstream_html(data_port) {
        Ok(html) => {
            let body = inject_head(&html, &bg, &fg, &gutter, &scrollbar, styles);
            write_html_response(&mut client, 200, "OK", &body);
        }
        Err(e) => write_simple_response(
            &mut client,
            502,
            "Bad Gateway",
            &format!("preview upstream error: {e}"),
        ),
    }
}

fn fetch_upstream_html(data_port: u16) -> std::io::Result<String> {
    let mut upstream = TcpStream::connect((Ipv4Addr::LOCALHOST, data_port))?;
    let request =
        format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{data_port}\r\nConnection: close\r\n\r\n");
    upstream.write_all(request.as_bytes())?;
    let mut bytes = Vec::new();
    upstream.read_to_end(&mut bytes)?;
    let split = bytes
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 4)
        .unwrap_or(0);
    Ok(String::from_utf8_lossy(&bytes[split..]).into_owned())
}

fn query_param_from_request(request: &[u8], key: &str) -> Option<String> {
    let first_line = String::from_utf8_lossy(request).lines().next()?.to_string();
    let path = first_line.split_whitespace().nth(1)?;
    let query = path.split_once('?')?.1;
    query_param(Some(query), key)
}

fn write_html_response(stream: &mut TcpStream, status: u16, reason: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Security-Policy: {PROXY_CSP}\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

fn write_simple_response(stream: &mut TcpStream, status: u16, reason: &str, message: &str) {
    let body = format!("<!doctype html><title>{message}</title>");
    write_html_response(stream, status, reason, &body);
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

// Tauri injects state + the call args individually, so the arg count is inherent.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn plugins_preview_start(
    app: AppHandle,
    db: State<'_, Db>,
    registry: State<'_, PreviewServiceRegistry>,
    id: String,
    service_id: String,
    session_key: String,
    input: String,
    settings: Option<HashMap<String, String>>,
) -> CommandResult<PreviewServiceHandle> {
    if cfg!(mobile) {
        return Err(AppError::InvalidArg("preview services are desktop-only".into()).into());
    }
    // Snapshot of the plugin's own settings (id → value) fed into `{setting:<id>}`
    // arg placeholders, each restricted to a safe CLI charset.
    let settings: HashMap<String, String> = settings
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| (k, sanitize_setting_value(&v)))
        .collect();
    db.with_conn(|c| super::require_enabled_permission(c, &id, PERM_NATIVE_SERVICES_RUN))?;

    let third_party_dir = discovery::third_party_plugins_dir(&app)?;
    let plugin = discovery::find(&third_party_dir, &id)
        .ok_or_else(|| AppError::NotFound(format!("plugin {id} not found on disk")))?;
    let service = find_service(&plugin.manifest, &service_id)?;
    if service.preview_iframe.mode != PreviewIframeMode::Themed
        && service.preview_iframe.css.is_some()
    {
        return Err(AppError::InvalidArg(
            "preview iframe css is only allowed when mode is themed".into(),
        )
        .into());
    }
    let proxy_styles = if service.preview_iframe.mode == PreviewIframeMode::Themed {
        Some(PreviewProxyStyles {
            plugin_css: load_plugin_preview_css(
                &plugin.files,
                service.preview_iframe.css.as_deref(),
            )?,
            socket_rewrite_port: service.preview_iframe.socket_rewrite_port,
        })
    } else {
        None
    };

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
            .map(|a| substitute(a, data_port, control_port, &input_str, &settings))
            .collect();
        let child = Command::new(&binary)
            .args(&args)
            .current_dir(&cwd)
            .spawn()?;
        let data_url = substitute(
            &service.data_url,
            data_port,
            control_port,
            &input_str,
            &settings,
        );
        let control_url = substitute(
            &service.control_url,
            data_port,
            control_port,
            &input_str,
            &settings,
        );
        let (proxy, proxy_url) = match proxy_styles {
            Some(styles) => {
                let proxy = start_loopback_proxy(data_port, styles)?;
                let proxy_url = proxy.url();
                (Some(proxy), Some(proxy_url))
            }
            None => (None, None),
        };
        let mut session = Session {
            child,
            input_path,
            data_port,
            proxy,
        };
        if let Err(e) = wait_until_ready(data_port) {
            session.kill();
            return Err(e);
        }
        Ok((session, data_url, control_url, proxy_url))
    })
    .await
    .map_err(|e| AppError::InvalidArg(format!("preview service task failed: {e}")))??;

    let (session, data_url, control_url, proxy_url) = handle;
    registry
        .sessions
        .lock()
        .map_err(|_| AppError::InvalidArg("preview registry poisoned".into()))?
        .insert(session_key.clone(), session);

    Ok(PreviewServiceHandle {
        session_key,
        data_url,
        control_url,
        proxy_url,
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

// ---------- Reverse proxy (theme injection) -------------------------------

fn query_param(query: Option<&str>, key: &str) -> Option<String> {
    for pair in query?.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                let form_value = v.replace('+', " ");
                return Some(
                    urlencoding::decode(&form_value)
                        .map(|c| c.into_owned())
                        .unwrap_or(form_value),
                );
            }
        }
    }
    None
}

/// Restrict a caller-supplied color to a tiny CSS-safe charset — it's injected
/// into a `<style>`, so it must not be able to carry `<`, `;`, `{`, `}`, quotes,
/// etc. and break out. Invalid input falls back to the app's dark background.
fn sanitize_css_color(bg: &str) -> String {
    let ok = !bg.is_empty()
        && bg.len() <= 63
        && bg.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '#' | '(' | ')' | ',' | '.' | '%' | ' ')
        });
    if ok {
        bg.to_string()
    } else {
        "oklch(0.1735 0.002 286.18)".to_string()
    }
}

fn sanitize_css_length(value: &str) -> String {
    let ok = !value.is_empty()
        && value.len() <= 32
        && value
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | '%' | 'p' | 'x' | 'r' | 'e' | 'm'));
    if ok {
        value.to_string()
    } else {
        "12px".to_string()
    }
}

/// Insert the (optional) WebSocket shim, app-theme variables, the plugin's own
/// preview CSS, and the readiness beacon into the document head.
///
/// The host stays tool-agnostic: it exposes the app theme as `--ms-preview-*`
/// custom properties and lets the plugin's `previewIframe.css` map them onto its
/// frontend's DOM (so nothing here knows tinymist's markup). The only behavioural
/// hook is a generic WebSocket shim, injected before the upstream scripts *only*
/// when the plugin declares `socketRewritePort`: a frontend that hardcodes a
/// default `ws://127.0.0.1:<port>` is redirected to this proxy origin, where the
/// proxy rewrites the handshake Origin before tunneling upstream. The beacon lets
/// the client confirm scripts actually ran.
fn inject_head(
    html: &str,
    bg: &str,
    fg: &str,
    gutter: &str,
    scrollbar: &str,
    styles: &PreviewProxyStyles,
) -> String {
    let plugin_css = styles
        .plugin_css
        .as_ref()
        .map(|css| format!("<style data-ms-plugin-preview-css>{css}</style>"))
        .unwrap_or_default();
    let socket_shim = match styles.socket_rewrite_port {
        Some(port) => format!(
            "<script>(()=>{{\
             const NativeWebSocket=window.WebSocket;\
             if(!NativeWebSocket||NativeWebSocket.__msPreviewPatched)return;\
             function rewrite(url){{\
               try{{\
                 const next=new URL(String(url),window.location.href);\
                 const isDefaultSocket=/^wss?:$/.test(next.protocol)&&(next.hostname==='127.0.0.1'||next.hostname==='localhost')&&next.port==='{port}';\
                 if(!isDefaultSocket)return url;\
                 next.protocol='ws:';\
                 next.hostname=window.location.hostname;\
                 next.port=window.location.port;\
                 return next.href;\
               }}catch(_){{return url;}}\
             }}\
             function PatchedWebSocket(url,protocols){{\
               return arguments.length>1?new NativeWebSocket(rewrite(url),protocols):new NativeWebSocket(rewrite(url));\
             }}\
             PatchedWebSocket.prototype=NativeWebSocket.prototype;\
             Object.setPrototypeOf(PatchedWebSocket,NativeWebSocket);\
             Object.defineProperty(PatchedWebSocket,'__msPreviewPatched',{{value:true}});\
             window.WebSocket=PatchedWebSocket;\
             }})();</script>"
        ),
        None => String::new(),
    };
    let inject = format!(
        "{socket_shim}\
         <style>:root{{--ms-preview-background:{bg};--ms-preview-foreground:{fg};\
         --ms-preview-gutter:{gutter};\
         --ms-preview-scrollbar:{scrollbar};}}</style>\
         {plugin_css}\
         <script>try{{parent.postMessage({{type:'ms-preview-proxy-ready'}},'*');}}catch(e){{}}</script>"
    );
    match html.find("<head>") {
        Some(idx) => {
            let insert_at = idx + "<head>".len();
            format!("{}{}{}", &html[..insert_at], inject, &html[insert_at..])
        }
        None => format!("{inject}{html}"),
    }
}

fn html_response(status: u16, body: String) -> tauri::http::Response<Cow<'static, [u8]>> {
    tauri::http::Response::builder()
        .status(status)
        .header(
            tauri::http::header::CONTENT_TYPE,
            "text/html; charset=utf-8",
        )
        .header(tauri::http::header::CONTENT_SECURITY_POLICY, PROXY_CSP)
        .header(tauri::http::header::CACHE_CONTROL, "no-store")
        .body(Cow::Owned(body.into_bytes()))
        .unwrap_or_else(|_| tauri::http::Response::new(Cow::Borrowed(&b""[..])))
}

/// Serve the tinymist preview frontend from *our* origin with an app-theme
/// background injected. The frontend is a single self-contained file, but it
/// derives its control-plane socket from `location.host`; the injected shim keeps
/// that socket pointed at the validated loopback server while the document
/// itself comes from our themed proxy origin. The requested `session` is
/// validated against the running registry so this can't be pointed at an
/// arbitrary loopback port.
pub async fn proxy_preview_html<R: Runtime>(
    app: AppHandle<R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Cow<'static, [u8]>> {
    let query = request.uri().query().map(str::to_string);
    let session = query_param(query.as_deref(), "session");
    let bg = sanitize_css_color(&query_param(query.as_deref(), "bg").unwrap_or_default());
    let fg = sanitize_css_color(&query_param(query.as_deref(), "fg").unwrap_or_default());
    let gutter = sanitize_css_length(&query_param(query.as_deref(), "gutter").unwrap_or_default());
    let scrollbar =
        sanitize_css_color(&query_param(query.as_deref(), "scrollbar").unwrap_or_default());

    let proxy = session
        .as_deref()
        .and_then(|s| app.state::<PreviewServiceRegistry>().themed_proxy(s));
    let Some((data_port, styles)) = proxy else {
        return html_response(
            404,
            "<!doctype html><title>unknown themed preview session</title>".into(),
        );
    };

    match reqwest::get(format!("http://127.0.0.1:{data_port}/")).await {
        Ok(resp) => match resp.text().await {
            Ok(html) => html_response(
                200,
                inject_head(&html, &bg, &fg, &gutter, &scrollbar, &styles),
            ),
            Err(e) => html_response(
                502,
                format!("<!doctype html><title>preview read error: {e}</title>"),
            ),
        },
        Err(e) => html_response(
            502,
            format!("<!doctype html><title>preview upstream error: {e}</title>"),
        ),
    }
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
            &HashMap::new(),
        );
        assert_eq!(
            out,
            "preview --data-plane-host 127.0.0.1:4001 --control-plane-host 127.0.0.1:4002 C:/x/doc.typ"
        );
    }

    #[test]
    fn substitutes_setting_placeholders_from_the_snapshot() {
        let settings = HashMap::from([("partial-rendering".to_string(), "true".to_string())]);
        let out = substitute("{setting:partial-rendering}", 1, 2, "in", &settings);
        assert_eq!(out, "true");
        // A placeholder with no matching setting is left untouched (manifest bug),
        // never silently turned into an empty flag value here.
        let out = substitute("{setting:missing}", 1, 2, "in", &settings);
        assert_eq!(out, "{setting:missing}");
    }

    #[test]
    fn sanitize_setting_value_strips_unsafe_and_leading_dashes() {
        assert_eq!(sanitize_setting_value("true"), "true");
        assert_eq!(sanitize_setting_value("split"), "split");
        // A value that tries to look like a flag loses its leading dashes.
        assert_eq!(sanitize_setting_value("--danger"), "danger");
        // Shell/space/quote characters are dropped entirely.
        assert_eq!(sanitize_setting_value("a b; rm -rf /"), "abrm-rf");
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
    fn sanitize_css_color_allows_safe_colors_rejects_injection() {
        assert_eq!(sanitize_css_color("#1e1e1e"), "#1e1e1e");
        assert_eq!(sanitize_css_color("rgb(30, 30, 30)"), "rgb(30, 30, 30)");
        assert_eq!(
            sanitize_css_color("rgba(255, 255, 255, 0.3)"),
            "rgba(255, 255, 255, 0.3)"
        );
        // Tailwind v4 themes resolve to oklch(); it must pass through.
        assert_eq!(sanitize_css_color("oklch(0.269 0 0)"), "oklch(0.269 0 0)");
        // Anything that could break out of the <style> falls back.
        assert_eq!(
            sanitize_css_color("</style><script>"),
            "oklch(0.1735 0.002 286.18)"
        );
        assert_eq!(
            sanitize_css_color("red;} body{"),
            "oklch(0.1735 0.002 286.18)"
        );
        assert_eq!(sanitize_css_color(""), "oklch(0.1735 0.002 286.18)");
    }

    #[test]
    fn sanitize_css_length_allows_simple_lengths_rejects_injection() {
        assert_eq!(sanitize_css_length("12px"), "12px");
        assert_eq!(sanitize_css_length("0.75rem"), "0.75rem");
        assert_eq!(sanitize_css_length("5%"), "5%");
        assert_eq!(sanitize_css_length("calc(1px)"), "12px");
        assert_eq!(sanitize_css_length("12px;body{}"), "12px");
        assert_eq!(sanitize_css_length(""), "12px");
    }

    #[test]
    fn preview_css_path_is_safe_relative_css() {
        assert!(is_safe_preview_css_path("preview.css"));
        assert!(is_safe_preview_css_path("styles/preview.theme.css"));
        assert!(!is_safe_preview_css_path("../preview.css"));
        assert!(!is_safe_preview_css_path("/preview.css"));
        assert!(!is_safe_preview_css_path("styles\\preview.css"));
        assert!(!is_safe_preview_css_path(".hidden.css"));
        assert!(!is_safe_preview_css_path("preview.txt"));
    }

    #[test]
    fn sanitize_plugin_preview_css_rejects_breakout_tokens() {
        assert!(sanitize_plugin_preview_css(":root { color: red; }").is_ok());
        assert!(sanitize_plugin_preview_css("</style><script>").is_err());
        assert!(sanitize_plugin_preview_css("@import url('x.css')").is_err());
        assert!(sanitize_plugin_preview_css("body{background:url(javascript:alert(1))}").is_err());
    }

    #[test]
    fn inject_head_injects_theme_vars_plugin_css_and_beacon_before_head_close() {
        // The host is tool-agnostic: it injects the app-theme variables and the
        // plugin's own preview CSS (which maps them onto the frontend DOM), plus
        // a readiness beacon — no tool-specific styling of its own.
        let styles = PreviewProxyStyles {
            plugin_css: Some(
                ":root{--typst-preview-background-color:var(--ms-preview-background)!important;}"
                    .to_string(),
            ),
            socket_rewrite_port: None,
        };
        let out = inject_head(
            "<html><head><title>x</title></head><body></body></html>",
            "#222",
            "rgb(255,255,255)",
            "14px",
            "rgba(255,255,255,0.3)",
            &styles,
        );
        let style_at = out.find("--ms-preview-background:#222").unwrap();
        let plugin_style_at = out
            .find("--typst-preview-background-color:var(--ms-preview-background)")
            .unwrap();
        let head_open = out.find("<head>").unwrap();
        let title_at = out.find("<title>x</title>").unwrap();
        assert!(head_open < style_at, "theme vars injected inside head");
        assert!(style_at < title_at, "injection precedes upstream head");
        assert!(
            style_at < plugin_style_at && plugin_style_at < title_at,
            "plugin css follows host theme vars and precedes upstream head"
        );
        assert!(
            out.contains("data-ms-plugin-preview-css"),
            "plugin css style tag is marked"
        );
        assert!(
            out.contains("--ms-preview-gutter:14px"),
            "gutter var injected"
        );
        assert!(
            out.contains("--ms-preview-foreground:rgb(255,255,255)"),
            "foreground var injected"
        );
        // The host no longer ships any scrollbar/DOM styling of its own — that
        // lives in the plugin's preview.css now.
        assert!(
            !out.contains("::-webkit-scrollbar"),
            "host injects no tool-specific scrollbar CSS"
        );
        // No socketRewritePort → no WebSocket shim.
        assert!(
            !out.contains("__msPreviewPatched"),
            "no shim without a declared socket port"
        );
        assert!(out.contains("ms-preview-proxy-ready"), "beacon injected");
    }

    #[test]
    fn inject_head_falls_back_when_no_head() {
        let out = inject_head(
            "<body>hi</body>",
            "#333",
            "rgb(255,255,255)",
            "12px",
            "rgba(255,255,255,0.3)",
            &PreviewProxyStyles::default(),
        );
        // With no <head> and no shim, injection is prepended, starting with the
        // theme-variable <style>.
        assert!(out.starts_with("<style>"));
        assert!(out.contains("hi"));
    }

    #[test]
    fn inject_head_shim_redirects_the_declared_socket_port_to_the_proxy_origin() {
        let styles = PreviewProxyStyles {
            plugin_css: None,
            socket_rewrite_port: Some(23625),
        };
        let out = inject_head(
            "<html><head><script>window.upstreamStarted=true;</script></head></html>",
            "#444",
            "rgb(255,255,255)",
            "12px",
            "rgba(255,255,255,0.3)",
            &styles,
        );
        let shim_at = out.find("__msPreviewPatched").unwrap();
        let upstream_at = out.find("window.upstreamStarted=true").unwrap();
        assert!(shim_at < upstream_at, "shim runs before upstream scripts");
        // The declared port drives the rewrite predicate.
        assert!(
            out.contains("next.port==='23625'"),
            "port from the manifest"
        );
        assert!(out.contains("next.hostname=window.location.hostname"));
        assert!(out.contains("new NativeWebSocket(rewrite(url),protocols)"));
    }

    #[test]
    fn inject_head_omits_the_shim_when_no_socket_port_is_declared() {
        let out = inject_head(
            "<html><head></head></html>",
            "#444",
            "rgb(255,255,255)",
            "12px",
            "rgba(255,255,255,0.3)",
            &PreviewProxyStyles::default(),
        );
        assert!(!out.contains("__msPreviewPatched"), "no shim by default");
    }

    #[test]
    fn query_param_decodes() {
        let q = Some("session=a%3Ab&bg=rgb(1%2C2%2C3)&theme=oklch%280.1735+0.002+286.18%29");
        assert_eq!(query_param(q, "session").as_deref(), Some("a:b"));
        assert_eq!(query_param(q, "bg").as_deref(), Some("rgb(1,2,3)"));
        assert_eq!(
            query_param(q, "theme").as_deref(),
            Some("oklch(0.1735 0.002 286.18)")
        );
        assert_eq!(query_param(q, "missing"), None);
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
        assert_eq!(svc.preview_iframe.mode, PreviewIframeMode::Direct);
        assert!(find_service(&manifest, "ghost").is_err());
    }

    #[test]
    fn find_service_reads_themed_preview_iframe_config() {
        let manifest = serde_json::json!({
            "contributes": { "nativeServices": [{
                "id": "tinymist",
                "binaryName": "tinymist",
                "args": ["preview", "{input}"],
                "dataUrl": "http://127.0.0.1:{dataPort}",
                "controlUrl": "ws://127.0.0.1:{controlPort}",
                "previewIframe": { "mode": "themed", "css": "preview.css", "socketRewritePort": 23625 }
            }]}
        });
        let svc = find_service(&manifest, "tinymist").unwrap();
        assert_eq!(svc.preview_iframe.mode, PreviewIframeMode::Themed);
        assert_eq!(svc.preview_iframe.css.as_deref(), Some("preview.css"));
        assert_eq!(svc.preview_iframe.socket_rewrite_port, Some(23625));
    }

    #[test]
    fn parse_services_is_empty_when_manifest_declares_none() {
        assert!(parse_services(&serde_json::json!({})).unwrap().is_empty());
        assert!(parse_services(&serde_json::json!({ "contributes": {} }))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn parse_services_rejects_a_malformed_declaration() {
        let manifest = serde_json::json!({
            "contributes": { "nativeServices": [{ "id": 42 }] }
        });
        let err = parse_services(&manifest).unwrap_err();
        assert!(matches!(err, AppError::InvalidArg(_)));
    }

    #[test]
    fn substitute_replaces_repeated_and_absent_placeholders() {
        // {input} appears twice; {controlPort} is absent from the template.
        let out = substitute(
            "{input} -> {dataPort} :: {input}",
            10,
            20,
            "X",
            &HashMap::new(),
        );
        assert_eq!(out, "X -> 10 :: X");
    }

    #[test]
    fn load_plugin_preview_css_returns_none_without_a_path() {
        let files = discovery::PluginFiles::Fs(PathBuf::from("."));
        assert!(load_plugin_preview_css(&files, None).unwrap().is_none());
    }

    #[test]
    fn load_plugin_preview_css_rejects_an_unsafe_path() {
        let files = discovery::PluginFiles::Fs(PathBuf::from("."));
        let err = load_plugin_preview_css(&files, Some("../secret.css")).unwrap_err();
        assert!(matches!(err, AppError::InvalidArg(_)));
    }

    #[test]
    fn is_websocket_upgrade_detects_the_upgrade_header() {
        assert!(is_websocket_upgrade(
            b"GET /ws HTTP/1.1\r\nUpgrade: websocket\r\n\r\n"
        ));
        // Case-insensitive on both the header name and value.
        assert!(is_websocket_upgrade(
            b"GET / HTTP/1.1\r\nupgrade: WebSocket\r\n\r\n"
        ));
        assert!(!is_websocket_upgrade(
            b"GET / HTTP/1.1\r\nConnection: keep-alive\r\n\r\n"
        ));
    }

    #[test]
    fn rewrite_ws_handshake_retargets_host_and_origin_upstream() {
        let request = b"GET /ws HTTP/1.1\r\nHost: 127.0.0.1:9999\r\nOrigin: http://127.0.0.1:9999\r\nUpgrade: websocket\r\n\r\n";
        let out = rewrite_ws_handshake(request, 4321);
        assert!(out.contains("Host: 127.0.0.1:4321"));
        assert!(out.contains("Origin: http://127.0.0.1:4321"));
        // Non host/origin lines are preserved verbatim; rewrite stops at the
        // blank line that ends the handshake head.
        assert!(out.contains("Upgrade: websocket"));
        assert!(out.ends_with("\r\n\r\n"));
    }

    #[test]
    fn query_param_from_request_reads_the_request_line_query() {
        let request = b"GET /proxy?bg=%23222&gutter=10px HTTP/1.1\r\nHost: x\r\n\r\n";
        assert_eq!(
            query_param_from_request(request, "bg").as_deref(),
            Some("#222")
        );
        assert_eq!(
            query_param_from_request(request, "gutter").as_deref(),
            Some("10px")
        );
        assert_eq!(query_param_from_request(request, "missing"), None);
        // A path with no query yields nothing rather than panicking.
        assert_eq!(
            query_param_from_request(b"GET / HTTP/1.1\r\n\r\n", "bg"),
            None
        );
    }

    /// Spawn a throwaway loopback HTTP server that answers exactly one request
    /// with a fixed HTML body, then returns its port. Used to stand in for the
    /// real preview server so the proxy plumbing can be exercised end-to-end.
    fn fake_upstream(body: &'static str) -> u16 {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut sock, _)) = listener.accept() {
                let mut buf = [0_u8; 1024];
                let _ = sock.read(&mut buf);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes());
            }
        });
        port
    }

    #[test]
    fn fetch_upstream_html_strips_the_response_headers() {
        let port = fake_upstream("<html><head></head><body>hi</body></html>");
        let html = fetch_upstream_html(port).unwrap();
        assert_eq!(html, "<html><head></head><body>hi</body></html>");
    }

    #[test]
    fn fetch_upstream_html_errors_when_nothing_listens() {
        // Bind then drop to obtain a port that is (very likely) not accepting.
        let port = {
            let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            l.local_addr().unwrap().port()
        };
        assert!(fetch_upstream_html(port).is_err());
    }

    #[test]
    fn loopback_proxy_serves_theme_injected_html_over_a_real_socket() {
        let upstream_port =
            fake_upstream("<html><head><title>doc</title></head><body>doc</body></html>");
        let proxy = start_loopback_proxy(upstream_port, PreviewProxyStyles::default()).unwrap();
        assert_eq!(proxy.url(), format!("http://127.0.0.1:{}", proxy.port));

        let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, proxy.port)).unwrap();
        client
            .write_all(
                b"GET /?bg=%23222&gutter=10px HTTP/1.1\r\nHost: proxy\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
        let mut resp = String::new();
        client.read_to_string(&mut resp).unwrap();

        assert!(resp.contains("200 OK"), "proxy returns 200: {resp}");
        assert!(resp.contains(PROXY_CSP), "proxy sets its own CSP");
        assert!(
            resp.contains("--ms-preview-background:#222"),
            "sanitized bg query param is injected"
        );
        assert!(resp.contains("--ms-preview-gutter:10px"));
        assert!(resp.contains("ms-preview-proxy-ready"), "beacon injected");
        assert!(
            resp.contains("<title>doc</title>"),
            "upstream body preserved"
        );

        proxy.shutdown();
    }

    #[test]
    fn loopback_proxy_returns_502_when_upstream_is_down() {
        // Reserve a port with no listener so the proxy's upstream fetch fails.
        let dead_port = {
            let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            l.local_addr().unwrap().port()
        };
        let proxy = start_loopback_proxy(dead_port, PreviewProxyStyles::default()).unwrap();

        let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, proxy.port)).unwrap();
        client
            .write_all(b"GET / HTTP/1.1\r\nHost: proxy\r\nConnection: close\r\n\r\n")
            .unwrap();
        let mut resp = String::new();
        client.read_to_string(&mut resp).unwrap();

        assert!(resp.contains("502 Bad Gateway"), "got: {resp}");
        assert!(resp.contains("preview upstream error"));

        proxy.shutdown();
    }
}
