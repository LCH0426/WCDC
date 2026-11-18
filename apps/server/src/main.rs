mod api;
mod auth;
mod config;
mod history;
mod images;
mod logs;
mod metrics;
mod net;
mod storage;
mod terminal;
mod transcode;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{any, delete, get, post};
use axum::Router;
use quark_core::{AppCore, CoreConfig};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

use crate::api::AppState;
use crate::auth::AuthService;
use crate::config::WebConfig;
use crate::logs::{LogBuffer, LogLayer};

#[tokio::main]
async fn main() -> Result<()> {
    let config = WebConfig::from_env()?;
    let log_buffer = init_tracing(&config.data_dir);

    let default_volume = config
        .default_volume()
        .context("至少需要一个存储盘")?
        .clone();

    let mut core_config = CoreConfig::default();
    core_config.data_dir = config.data_dir.clone();
    core_config.download_dir = std::path::PathBuf::from(&default_volume.path);
    core_config.api_base = config.api_base.clone();
    core_config.pc_api_base = config.pc_api_base.clone();
    core_config.account_base = Some(config.account_base.clone());
    core_config.oss_base_override = config.oss_base_override.clone();
    core_config.qr_login = config.qr_login.clone();
    let core = AppCore::new(core_config)
        .await
        .context("初始化夸克核心失败")?;

    let ffmpeg_setting = match core.get_setting(transcode::SETTING_FFMPEG_PATH).await {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(%error, "读取 ffmpeg 路径设置失败，将使用自动检测");
            None
        }
    };
    let persisted_probe = match core.get_setting(transcode::SETTING_PROBE).await {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(%error, "读取 ffmpeg 检测缓存失败，将重新检测");
            None
        }
    };
    let history = history::HistoryService::new(&config.data_dir);
    let transcode = Arc::new(transcode::TranscodeService::new(
        core.clone(),
        ffmpeg_setting,
        persisted_probe,
        history.clone(),
    ));
    let images = Arc::new(images::ImageService::new(history.clone()));

    let password_hash = core
        .get_setting(auth::AUTH_SETTING_KEY)
        .await
        .context("读取访问密码失败")?;
    if password_hash.is_none() {
        tracing::info!("site access password is not set; the first visit will register one");
    }
    let auth = Arc::new(AuthService::new(password_hash));
    let metrics = crate::metrics::MetricsService::start();
    let lan_only = core
        .get_setting("web_lan_only")
        .await
        .context("读取内网访问设置失败")?
        .map(|value| value != "false")
        .unwrap_or(true);

    let state = AppState {
        core,
        config: Arc::new(config.clone()),
        auth,
        logs: log_buffer,
        metrics,
        lan_only: Arc::new(tokio::sync::RwLock::new(lan_only)),
        transcode,
        images,
        history,
    };

    let app = router(state);

    let addr: SocketAddr = config
        .bind
        .parse()
        .with_context(|| format!("无效的监听地址 {}", config.bind))?;
    tracing::info!(%addr, data_dir = %config.data_dir.display(), "wcdc server listening");
    for volume in &config.volumes {
        tracing::info!(id = %volume.id, name = %volume.name, path = %volume.path, "storage volume");
    }
    #[cfg(unix)]
    if let Some(socket) = config.unix_socket.as_deref() {
        if socket.exists() {
            let _ = std::fs::remove_file(socket);
        }
        if let Some(parent) = socket.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let listener = tokio::net::UnixListener::bind(socket)
            .with_context(|| format!("无法监听 Unix Socket {}", socket.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o666));
        }
        tracing::info!(socket = %socket.display(), "wcdc server listening on unix socket");
        axum::serve(listener, app.into_make_service())
            .with_graceful_shutdown(shutdown_signal())
            .await?;
        return Ok(());
    }
    #[cfg(not(unix))]
    if config.unix_socket.is_some() {
        tracing::warn!("WCDC_UNIX_SOCKET 仅支持 Unix，已回退到 TCP");
    }

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

#[derive(rust_embed::RustEmbed)]
#[folder = "../../web/dist"]
struct WebAssets;

async fn static_handler(State(state): State<AppState>, uri: Uri) -> Response {
    let prefix = state.config.gateway_prefix.as_deref().unwrap_or("");
    let raw = uri.path().trim_start_matches('/');
    let raw = if raw.is_empty() { "index.html" } else { raw };

    if let Some(directory) = state.config.static_dir.as_deref() {
        if let Some(response) = static_from_disk(directory, raw, prefix).await {
            return response;
        }
    }
    static_from_embed(raw, prefix)
}

async fn static_from_disk(directory: &Path, raw: &str, prefix: &str) -> Option<Response> {
    let relative = normalize_relative(raw)?;
    let mut candidate = directory.join(&relative);
    let mut name = raw.to_string();
    if !candidate.is_file() {
        if raw.contains('.') {
            return None;
        }
        candidate = directory.join("index.html");
        name = "index.html".to_string();
    }
    let bytes = tokio::fs::read(candidate).await.ok()?;
    if name == "index.html" {
        Some(index_response(&name, bytes, prefix))
    } else {
        Some(asset_response(&name, bytes))
    }
}

fn static_from_embed(raw: &str, prefix: &str) -> Response {
    if let Some(asset) = WebAssets::get(raw) {
        let bytes = asset.data.into_owned();
        return if raw == "index.html" {
            index_response(raw, bytes, prefix)
        } else {
            asset_response(raw, bytes)
        };
    }
    if raw.contains('.') {
        return StatusCode::NOT_FOUND.into_response();
    }
    match WebAssets::get("index.html") {
        Some(asset) => index_response("index.html", asset.data.into_owned(), prefix),
        None => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "前端资源未打包，请先执行 npm run build 后重新编译服务端",
        )
            .into_response(),
    }
}

fn index_response(name: &str, bytes: Vec<u8>, prefix: &str) -> Response {
    let href = if prefix.is_empty() {
        "/".to_string()
    } else {
        format!("{prefix}/")
    };
    let html = String::from_utf8_lossy(&bytes);
    let tag = format!("<base href=\"{href}\">");
    let html = if html.contains("<head>") {
        html.replacen("<head>", &format!("<head>{tag}"), 1)
    } else {
        format!("{tag}{html}")
    };
    asset_response(name, html.into_bytes())
}

async fn attach_client_ip(mut request: Request, next: Next) -> Response {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0)
        .unwrap_or_else(|| SocketAddr::from(([127, 0, 0, 1], 0)));
    let ip = net::client_ip(request.headers(), peer);
    request.extensions_mut().insert(net::ClientIp(ip));
    next.run(request).await
}

fn asset_response(name: &str, bytes: Vec<u8>) -> Response {
    let mime = mime_guess::from_path(name).first_or_octet_stream();
    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime.as_ref())
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    let cache = if name.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-store"
    };
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    response
}

fn normalize_relative(raw: &str) -> Option<PathBuf> {
    let mut path = PathBuf::new();
    for component in Path::new(raw).components() {
        match component {
            std::path::Component::Normal(part) => path.push(part),
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }
    Some(path)
}

fn router(state: AppState) -> Router {
    let prefix = state.config.gateway_prefix.clone();
    let base = build_router(state);
    match prefix {
        Some(prefix) => {
            let target = format!("{prefix}/");
            Router::new()
                .route(
                    "/",
                    get(move || {
                        let target = target.clone();
                        async move { Redirect::temporary(&target) }
                    }),
                )
                .merge(base.clone())
                .nest(&prefix, base)
        }
        None => base,
    }
}

fn build_router(state: AppState) -> Router {
    let dev_origins = state
        .config
        .dev_origins
        .iter()
        .filter_map(|origin| origin.parse::<HeaderValue>().ok())
        .collect::<Vec<_>>();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(dev_origins))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::ACCEPT,
            header::AUTHORIZATION,
            header::COOKIE,
            header::ORIGIN,
        ])
        .allow_credentials(true);

    Router::new()
        .route("/api/health", get(api::health))
        .route("/api/auth/status", get(api::auth_status))
        .route("/api/auth/register", post(api::auth_register))
        .route("/api/auth/login", post(api::auth_login))
        .route("/api/auth/logout", post(api::auth_logout))
        .route("/api/logs", get(api::logs).delete(api::clear_logs))
        .route("/api/bootstrap", get(api::bootstrap))
        .route("/api/volumes", get(api::volumes))
        .route("/api/volumes/usage", get(api::volume_usage))
        .route("/api/storage/roots", get(api::storage_roots))
        .route("/api/storage/browse", get(api::storage_browse))
        .route("/api/storage/mkdir", post(api::storage_mkdir))
        .route("/api/storage/files", get(api::storage_files))
        .route("/api/storage/file", get(api::storage_file))
        .route("/api/downloads", get(api::downloads))
        .route("/api/downloads/{id}/file", get(api::download_file))
        .route("/api/speedtest/ping", get(api::speedtest_ping))
        .route("/api/speedtest/download", get(api::speedtest_download))
        .route("/api/speedtest/upload", post(api::speedtest_upload))
        .route("/api/server/info", get(api::server_info))
        .route("/api/terminal/ws", get(terminal::terminal_ws))
        .route("/api/transcode/status", get(api::transcode_status))
        .route("/api/transcode/cached", get(api::transcode_cached))
        .route("/api/transcode/path", post(api::transcode_set_path))
        .route("/api/transcode/self-test", post(api::transcode_self_test))
        .route("/api/transcode/scan", post(api::transcode_scan))
        .route(
            "/api/transcode/scan/progress",
            get(api::transcode_scan_progress),
        )
        .route(
            "/api/transcode/jobs",
            get(api::transcode_jobs)
                .post(api::transcode_create_jobs)
                .delete(api::transcode_clear_jobs),
        )
        .route(
            "/api/transcode/jobs/{id}/cancel",
            post(api::transcode_cancel_job),
        )
        .route(
            "/api/transcode/jobs/{id}/retry",
            post(api::transcode_retry_job),
        )
        .route("/api/transcode/events", get(api::transcode_events))
        .route("/api/transcode/stats", get(api::transcode_stats))
        .route("/api/images/scan", post(api::images_scan))
        .route(
            "/api/images/jobs",
            get(api::images_jobs)
                .post(api::images_create_jobs)
                .delete(api::images_clear_jobs),
        )
        .route(
            "/api/images/jobs/{id}/cancel",
            post(api::images_cancel_job),
        )
        .route(
            "/api/images/jobs/{id}/retry",
            post(api::images_retry_job),
        )
        .route("/api/images/events", get(api::images_events))
        .route(
            "/api/history",
            get(api::history).delete(api::clear_history),
        )
        .route("/api/login/qr", post(api::start_qr_login))
        .route(
            "/api/login/qr/{session_id}",
            get(api::poll_qr_login).delete(api::cancel_qr_login),
        )
        .route("/api/login/cookie", post(api::login_with_cookie))
        .route("/api/accounts", get(api::accounts))
        .route(
            "/api/accounts/{account_id}",
            delete(api::logout),
        )
        .route(
            "/api/accounts/{account_id}/refresh",
            post(api::refresh_account),
        )
        .route("/api/files", get(api::list_dir))
        .route("/api/files/mkdir", post(api::mkdir))
        .route("/api/files/rename", post(api::rename))
        .route("/api/files/move", post(api::move_files))
        .route("/api/files/delete", post(api::delete_files))
        .route("/api/recycle", get(api::list_recycle))
        .route("/api/recycle/restore", post(api::restore_recycle))
        .route("/api/recycle/delete", post(api::delete_recycle))
        .route("/api/recycle/clear", post(api::clear_recycle))
        .route("/api/transfers", get(api::list_transfers))
        .route("/api/transfers/download", post(api::enqueue_download))
        .route("/api/transfers/clear", post(api::clear_transfers))
        .route(
            "/api/transfers/{id}/{action}",
            post(api::transfer_action),
        )
        .route("/api/transfers/{id}", delete(api::remove_transfer))
        .route("/api/events", get(api::events))
        .route(
            "/api/settings",
            get(api::get_settings).patch(api::update_settings),
        )
        .route(
            "/api/{*rest}",
            any(|| async {
                (
                    StatusCode::NOT_FOUND,
                    axum::Json(serde_json::json!({ "error": "接口不存在" })),
                )
            }),
        )
        .fallback(static_handler)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .layer(middleware::from_fn(no_cache_html))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            guard_cross_origin_writes,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_site_auth,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            enforce_lan_only,
        ))
        .layer(middleware::from_fn(attach_client_ip))
        .with_state(state)
}

/// Prevent browsers from keeping an old SPA shell after a rebuild.
async fn no_cache_html(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let is_html = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.starts_with("text/html"))
        .unwrap_or(false);
    if is_html {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        );
    }
    response
}

/// Every `/api` route except health/auth requires the site session cookie.
async fn require_site_auth(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    if !path.starts_with("/api/")
        || path == "/api/health"
        || path.starts_with("/api/auth/")
        || request.method() == Method::OPTIONS
    {
        return next.run(request).await;
    }
    let Some(token) = auth::session_from_headers(request.headers()) else {
        return unauthorized_response();
    };
    if state.auth.is_authenticated(&token).await {
        next.run(request).await
    } else {
        unauthorized_response()
    }
}

fn unauthorized_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        axum::Json(serde_json::json!({
            "error": "请先登录",
            "code": "site_auth_required",
        })),
    )
        .into_response()
}

/// LAN-only mode blocks API access from public IPs. `/api/health` and
/// `/api/auth/status` stay reachable so the UI can explain why login is blocked.
async fn enforce_lan_only(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    if !path.starts_with("/api/")
        || path == "/api/health"
        || path == "/api/auth/status"
        || request.method() == Method::OPTIONS
    {
        return next.run(request).await;
    }
    if !*state.lan_only.read().await {
        return next.run(request).await;
    }
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0)
        .unwrap_or_else(|| SocketAddr::from(([127, 0, 0, 1], 0)));
    let ip = net::client_ip(request.headers(), peer);
    if net::is_internal(ip) {
        next.run(request).await
    } else {
        (
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({
                "error": "只允许内网访问，请从内网登录或关闭“只允许内网登录”",
                "code": "lan_only",
            })),
        )
            .into_response()
    }
}

/// A random website must not be able to POST to this server through the user's
/// browser, especially now that the site session is a cookie.
async fn guard_cross_origin_writes(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let method = request.method().clone();
    let mutating = matches!(
        method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    );
    if mutating {
        if let Some(origin) = request
            .headers()
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
        {
            let host = request
                .headers()
                .get(header::HOST)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default();
            let forwarded_host = request
                .headers()
                .get("x-forwarded-host")
                .or_else(|| request.headers().get("x-real-host"))
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(',').next())
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let gateway_request = request.headers().contains_key("x-trim-userid")
                || request.headers().contains_key("x-trim-isadmin")
                // Unix Socket means the process is only reachable through the
                // local fnOS gateway, which has already authenticated the NAS user.
                || state.config.unix_socket.is_some();
            let dev_allowed = state
                .config
                .dev_origins
                .iter()
                .any(|allowed| allowed.trim_end_matches('/') == origin.trim_end_matches('/'));
            let same_host = origin_matches_host(origin, host)
                || forwarded_host
                    .map(|host| origin_matches_host(origin, host))
                    .unwrap_or(false);
            if !same_host && !dev_allowed && !gateway_request {
                tracing::warn!(
                    origin = %origin,
                    host = %host,
                    forwarded_host = ?forwarded_host,
                    "cross-origin write rejected"
                );
                return (
                    StatusCode::FORBIDDEN,
                    axum::Json(serde_json::json!({
                        "error": "拒绝跨站写入请求，请通过本站页面操作",
                    })),
                )
                    .into_response();
            }
        }
    }
    next.run(request).await
}

/// Compare an Origin header with a Host header, ignoring default ports and
/// scheme differences introduced by the fnOS reverse proxy.
fn origin_matches_host(origin: &str, host: &str) -> bool {
    if host.is_empty() {
        return false;
    }
    let Ok(origin_url) = url::Url::parse(origin) else {
        return false;
    };
    let Ok(host_url) = url::Url::parse(&format!("http://{host}")) else {
        return false;
    };
    let origin_host = origin_url.host_str().map(|value| value.to_ascii_lowercase());
    let host_host = host_url.host_str().map(|value| value.to_ascii_lowercase());
    origin_host == host_host
        && origin_url.port_or_known_default() == host_url.port_or_known_default()
}

fn init_tracing(data_dir: &Path) -> LogBuffer {
    let buffer = LogBuffer::new(data_dir.join("server.log"), 3000);
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("quark_web_server=info,quark_core=info,warn"));
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_target(false))
        .with(LogLayer::new(buffer.clone()))
        .try_init();
    buffer
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}
