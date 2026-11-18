use std::env;
use std::io::{Read, Write};
#[cfg(unix)]
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;

use crate::api::AppState;
use crate::net;

const MAX_SESSIONS: usize = 4;
static ACTIVE_SESSIONS: AtomicUsize = AtomicUsize::new(0);

struct SessionGuard;

impl Drop for SessionGuard {
    fn drop(&mut self) {
        ACTIVE_SESSIONS.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ControlMessage {
    Resize { cols: u16, rows: u16 },
}

struct ShellSpec {
    program: String,
}

/// WebSocket terminal. The global auth and LAN-only middleware already guard
/// this route; the handler repeats the checks so the feature fails closed even
/// if routing changes later.
pub async fn terminal_ws(
    State(state): State<AppState>,
    axum::Extension(client): axum::Extension<net::ClientIp>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if state.config.fnos_mode {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "fnOS 应用版本不提供终端功能",
                "code": "terminal_disabled",
            })),
        )
            .into_response();
    }
    if !*state.lan_only.read().await {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "终端功能要求开启“只允许内网访问”",
                "code": "terminal_requires_lan_only",
            })),
        )
            .into_response();
    }

    let ip = client.0;
    if !net::is_internal(ip) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "终端只允许从内网访问",
                "code": "terminal_lan_only",
            })),
        )
            .into_response();
    }

    if !origin_allowed(&headers, &state.config.dev_origins) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "非法的终端来源",
                "code": "terminal_origin_denied",
            })),
        )
            .into_response();
    }

    let previous = ACTIVE_SESSIONS.fetch_add(1, Ordering::SeqCst);
    if previous >= MAX_SESSIONS {
        ACTIVE_SESSIONS.fetch_sub(1, Ordering::SeqCst);
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "error": "终端会话数已达上限",
                "code": "terminal_busy",
            })),
        )
            .into_response();
    }

    let shell = shell_spec();
    let shell_label = shell.program.clone();
    tracing::info!(client = %ip, shell = %shell_label, "terminal session requested");

    let guard = SessionGuard;
    ws.max_message_size(4 * 1024 * 1024)
        .max_frame_size(1024 * 1024)
        .on_upgrade(move |socket| async move {
            let _guard = guard;
            if let Err(error) = run_terminal(socket, shell, ip).await {
                tracing::warn!(client = %ip, error = %error, "terminal session ended with error");
            }
        })
}

async fn run_terminal(
    socket: WebSocket,
    shell: ShellSpec,
    ip: std::net::IpAddr,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("无法创建 PTY: {error}"))?;

    let mut command = CommandBuilder::new(&shell.program);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    if let Some(home) = dirs::home_dir() {
        command.cwd(home);
    }

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("无法读取 PTY: {error}"))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("无法写入 PTY: {error}"))?;
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("无法启动 shell: {error}"))?;
    drop(pair.slave);
    let master = Arc::new(Mutex::new(pair.master));

    let (output_tx, mut output_rx) = mpsc::channel::<Vec<u8>>(256);
    std::thread::Builder::new()
        .name("terminal-reader".to_string())
        .spawn(move || {
            let mut buffer = [0_u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(size) => {
                        if output_tx.blocking_send(buffer[..size].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        })
        .map_err(|error| format!("无法启动终端读取线程: {error}"))?;

    let (write_tx, write_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::Builder::new()
        .name("terminal-writer".to_string())
        .spawn(move || {
            while let Ok(data) = write_rx.recv() {
                if writer.write_all(&data).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
        })
        .map_err(|error| format!("无法启动终端写入线程: {error}"))?;

    let (mut sender, mut receiver) = socket.split();
    let hello = json!({
        "type": "hello",
        "shell": shell.program,
        "platform": env::consts::OS,
    });
    sender
        .send(Message::Text(hello.to_string().into()))
        .await
        .map_err(|error| format!("无法发送终端欢迎信息: {error}"))?;

    let mut ping = tokio::time::interval(Duration::from_secs(30));
    ping.tick().await;

    loop {
        tokio::select! {
            output = output_rx.recv() => {
                match output {
                    Some(bytes) => {
                        if sender
                            .send(Message::Binary(bytes.into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    None => break,
                }
            }
            message = receiver.next() => {
                match message {
                    Some(Ok(Message::Binary(data))) => {
                        let _ = write_tx.send(data.to_vec());
                    }
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(ControlMessage::Resize { cols, rows }) =
                            serde_json::from_str::<ControlMessage>(&text)
                        {
                            let size = PtySize {
                                rows: rows.max(1),
                                cols: cols.max(1),
                                pixel_width: 0,
                                pixel_height: 0,
                            };
                            let master = master.clone();
                            let _ = tokio::task::spawn_blocking(move || {
                                if let Ok(master) = master.lock() {
                                    let _ = master.resize(size);
                                }
                            })
                            .await;
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        let _ = sender.send(Message::Pong(data)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            _ = ping.tick() => {
                if sender.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
        }
    }

    drop(write_tx);
    let _ = child.kill();
    drop(master);
    let exit = json!({ "type": "exit" });
    let _ = sender.send(Message::Text(exit.to_string().into())).await;
    tracing::info!(client = %ip, "terminal session closed");
    Ok(())
}

fn shell_spec() -> ShellSpec {
    let configured = env::var("WCDC_TERMINAL_SHELL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    #[cfg(windows)]
    {
        ShellSpec {
            program: configured.unwrap_or_else(|| "powershell.exe".to_string()),
        }
    }

    #[cfg(unix)]
    {
        let program = configured
            .or_else(|| env::var("SHELL").ok())
            .unwrap_or_else(|| "/bin/bash".to_string());
        let program = if Path::new(&program).is_file() {
            program
        } else {
            "/bin/sh".to_string()
        };
        ShellSpec { program }
    }

    #[cfg(not(any(windows, unix)))]
    {
        ShellSpec {
            program: configured.unwrap_or_else(|| "sh".to_string()),
        }
    }
}

fn origin_allowed(headers: &HeaderMap, dev_origins: &[String]) -> bool {
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim_end_matches('/'))
    else {
        return true;
    };
    if origin.eq_ignore_ascii_case("null") {
        return false;
    }
    if dev_origins
        .iter()
        .any(|allowed| allowed.trim_end_matches('/').eq_ignore_ascii_case(origin))
    {
        return true;
    }
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let origin_host = origin
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(origin);
    origin_host.eq_ignore_ascii_case(host)
}
