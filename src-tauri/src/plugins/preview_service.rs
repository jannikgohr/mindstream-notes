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
const PROXY_STYLE: &str = include_str!("preview_service.css");

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
    /// The server's data-plane HTTP port — where the reverse-proxy fetches the
    /// frontend HTML from.
    data_port: u16,
    /// The server's control-plane WebSocket port — where the proxied frontend
    /// sends preview/client messages.
    control_port: u16,
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
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
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

    /// The data/control ports of a running session, if any. Used by the reverse
    /// proxy to validate a request targets a real session (not arbitrary
    /// loopback ports).
    fn ports(&self, session_key: &str) -> Option<(u16, u16)> {
        let sessions = self.sessions.lock().ok()?;
        let session = sessions.get(session_key)?;
        Some((session.data_port, session.control_port))
    }
}

/// What `plugins_preview_start` returns to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewServiceHandle {
    pub session_key: String,
    pub data_url: String,
    pub control_url: String,
    pub proxy_url: String,
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

fn start_loopback_proxy(data_port: u16) -> AppResult<LoopbackPreviewProxy> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let join = thread::spawn(move || {
        for incoming in listener.incoming() {
            if thread_stop.load(Ordering::Relaxed) {
                break;
            }
            let Ok(stream) = incoming else {
                continue;
            };
            let conn_stop = Arc::clone(&thread_stop);
            thread::spawn(move || {
                if !conn_stop.load(Ordering::Relaxed) {
                    handle_proxy_connection(stream, data_port);
                }
            });
        }
    });
    Ok(LoopbackPreviewProxy {
        port,
        stop,
        join: Some(join),
    })
}

fn handle_proxy_connection(mut client: TcpStream, data_port: u16) {
    let Ok(request) = read_http_head(&mut client) else {
        return;
    };
    if request.is_empty() {
        return;
    }
    if is_websocket_upgrade(&request) {
        tunnel_websocket(client, request, data_port);
    } else {
        serve_proxied_html(client, request, data_port);
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

fn serve_proxied_html(mut client: TcpStream, request: Vec<u8>, data_port: u16) {
    let bg = sanitize_css_color(&query_param_from_request(&request, "bg").unwrap_or_default());
    let fg = sanitize_css_color(&query_param_from_request(&request, "fg").unwrap_or_default());
    let gutter =
        sanitize_css_length(&query_param_from_request(&request, "gutter").unwrap_or_default());
    let scrollbar =
        sanitize_css_color(&query_param_from_request(&request, "scrollbar").unwrap_or_default());
    match fetch_upstream_html(data_port) {
        Ok(html) => {
            let body = inject_head(&html, &bg, &fg, &gutter, &scrollbar);
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
        let proxy = start_loopback_proxy(data_port)?;
        let proxy_url = proxy.url();
        let mut session = Session {
            child,
            input_path,
            data_port,
            control_port,
            proxy: Some(proxy),
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

/// Insert our WebSocket shim, theme variables/styles, and readiness beacon into the
/// document head. The shim must run before the upstream scripts: any hardcoded
/// tinymist default data-plane URL is redirected to this loopback proxy origin,
/// where the proxy can rewrite the handshake Origin before tunneling upstream.
/// The theme CSS lives in `preview_service.css` so iframe layout/scrollbar tweaks
/// stay modular, and the beacon lets the client confirm scripts actually run.
fn inject_head(html: &str, bg: &str, fg: &str, gutter: &str, scrollbar: &str) -> String {
    let inject = format!(
        "<script>(()=>{{\
         const NativeWebSocket=window.WebSocket;\
         if(!NativeWebSocket||NativeWebSocket.__msPreviewPatched)return;\
         function rewrite(url){{\
           try{{\
             const next=new URL(String(url),window.location.href);\
             const defaultTinymistDataPlane=/^wss?:$/.test(next.protocol)&&(next.hostname==='127.0.0.1'||next.hostname==='localhost')&&next.port==='23625';\
             if(!defaultTinymistDataPlane)return url;\
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
         }})();</script>\
         <style>:root{{--typst-preview-background-color:{bg} !important;\
         --vscode-sideBar-background:{bg} !important;\
         --ms-preview-background:{bg};--ms-preview-foreground:{fg};\
         --ms-preview-gutter:{gutter};\
         --ms-preview-scrollbar:{scrollbar};}}</style>\
         <style>{PROXY_STYLE}</style>\
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

    let ports = session
        .as_deref()
        .and_then(|s| app.state::<PreviewServiceRegistry>().ports(s));
    let Some((data_port, _control_port)) = ports else {
        return html_response(
            404,
            "<!doctype html><title>unknown preview session</title>".into(),
        );
    };

    match reqwest::get(format!("http://127.0.0.1:{data_port}/")).await {
        Ok(resp) => match resp.text().await {
            Ok(html) => html_response(200, inject_head(&html, &bg, &fg, &gutter, &scrollbar)),
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
    fn inject_head_places_style_and_beacon_before_head_close() {
        let out = inject_head(
            "<html><head><title>x</title></head><body></body></html>",
            "#222",
            "rgb(255,255,255)",
            "14px",
            "rgba(255,255,255,0.3)",
        );
        let style_at = out.find("--typst-preview-background-color:#222").unwrap();
        let head_open = out.find("<head>").unwrap();
        let title_at = out.find("<title>x</title>").unwrap();
        assert!(head_open < style_at, "style injected inside head");
        assert!(
            style_at < title_at,
            "proxy scripts run before upstream head"
        );
        assert!(out.contains("--ms-preview-gutter:14px"), "gutter injected");
        assert!(
            out.contains("--ms-preview-foreground:rgb(255,255,255)"),
            "foreground injected"
        );
        assert!(
            out.contains("padding: var(--ms-preview-gutter) !important"),
            "body padding injected"
        );
        assert!(
            out.contains(
                "scrollbar-color: oklch(from var(--ms-preview-foreground) l c h / 0.3) transparent"
            ),
            "scrollbar color injected"
        );
        assert!(
            out.contains("background: oklch(from var(--ms-preview-foreground) l c h / 0.22)"),
            "webkit thumb matches app scrollbar opacity"
        );
        assert!(
            out.contains("background: oklch(from var(--ms-preview-foreground) l c h / 0.45)"),
            "webkit thumb hover matches app scrollbar opacity"
        );
        assert!(
            out.contains("overflow: hidden"),
            "outer iframe document scroller is hidden"
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
        );
        assert!(out.starts_with("<script>"));
        assert!(out.contains("hi"));
    }

    #[test]
    fn inject_head_redirects_default_tinymist_websockets_to_proxy_origin() {
        let out = inject_head(
            "<html><head><script>window.upstreamStarted=true;</script></head></html>",
            "#444",
            "rgb(255,255,255)",
            "12px",
            "rgba(255,255,255,0.3)",
        );
        let shim_at = out.find("defaultTinymistDataPlane").unwrap();
        let upstream_at = out.find("window.upstreamStarted=true").unwrap();
        assert!(shim_at < upstream_at, "shim runs before upstream scripts");
        assert!(out.contains("next.hostname=window.location.hostname"));
        assert!(out.contains("new NativeWebSocket(rewrite(url),protocols)"));
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
        assert!(find_service(&manifest, "ghost").is_err());
    }
}
