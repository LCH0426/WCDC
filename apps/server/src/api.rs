use std::collections::BTreeMap;
use std::convert::Infallible;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use bytes::Bytes;
use futures_util::StreamExt;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_stream::wrappers::BroadcastStream;
use tokio_util::io::ReaderStream;

use quark_core::{AccountView, AppCore, CoreError, DownloadItem, Settings, TransferView};
use quark_protocol::Error as ProtocolError;

use crate::auth::{self, AuthError, AuthService};
use crate::config::{VolumeConfig, WebConfig};
use crate::logs::LogBuffer;
use crate::storage;

#[derive(Clone)]
pub struct AppState {
    pub core: AppCore,
    pub config: Arc<WebConfig>,
    pub auth: Arc<AuthService>,
    pub logs: LogBuffer,
    pub metrics: crate::metrics::MetricsService,
    pub lan_only: Arc<tokio::sync::RwLock<bool>>,
    pub transcode: Arc<crate::transcode::TranscodeService>,
    pub images: Arc<crate::images::ImageService>,
    pub history: Arc<crate::history::HistoryService>,
}

pub struct ApiError {
    status: StatusCode,
    message: String,
    code: Option<&'static str>,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            code: None,
        }
    }

    fn with_code(
        status: StatusCode,
        message: impl Into<String>,
        code: &'static str,
    ) -> Self {
        Self {
            status,
            message: message.into(),
            code: Some(code),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({ "error": self.message });
        if let Some(code) = self.code {
            body["code"] = Value::String(code.to_string());
        }
        (self.status, Json(body)).into_response()
    }
}

impl From<CoreError> for ApiError {
    fn from(error: CoreError) -> Self {
        match &error {
            CoreError::Protocol(inner) if inner.is_auth() => {
                tracing::warn!(%error, "quark session expired");
                Self::with_code(
                    StatusCode::CONFLICT,
                    "夸克登录已失效，请重新扫码绑定",
                    "quark_auth_required",
                )
            }
            CoreError::AccountNotFound(_) | CoreError::TransferNotFound(_) => {
                Self::new(StatusCode::NOT_FOUND, error.to_string())
            }
            CoreError::InvalidInput(_) | CoreError::Json(_) => {
                Self::new(StatusCode::BAD_REQUEST, error.to_string())
            }
            CoreError::Protocol(inner) => Self::new(
                if inner.retryable() {
                    StatusCode::BAD_GATEWAY
                } else {
                    StatusCode::BAD_REQUEST
                },
                error.to_string(),
            ),
            _ => Self::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        }
    }
}

impl From<ProtocolError> for ApiError {
    fn from(error: ProtocolError) -> Self {
        if error.is_auth() {
            tracing::warn!(%error, "quark session expired");
            return Self::with_code(
                StatusCode::CONFLICT,
                "夸克登录已失效，请重新扫码绑定",
                "quark_auth_required",
            );
        }
        Self::new(StatusCode::BAD_GATEWAY, error.to_string())
    }
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    }
}

type ApiResult<T> = Result<Json<T>, ApiError>;

fn allowed_scope(state: &AppState) -> Option<&[PathBuf]> {
    if state.config.fnos_mode {
        Some(state.config.allowed_paths.as_slice())
    } else {
        None
    }
}

fn ensure_allowed_path(state: &AppState, path: &Path) -> Result<(), ApiError> {
    if state.config.fnos_mode {
        storage::ensure_within(path, &state.config.allowed_paths)
            .map_err(ApiError::bad_request)?;
    }
    Ok(())
}

pub async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "wcdc-server" }))
}

#[derive(Debug, Deserialize)]
pub struct PasswordRequest {
    pub password: String,
}

fn auth_error_response(error: AuthError) -> ApiError {
    match error {
        AuthError::Locked(seconds) => ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            format!("尝试次数过多，请 {seconds} 秒后再试"),
        ),
        AuthError::InvalidPassword | AuthError::NotRegistered => {
            ApiError::new(StatusCode::UNAUTHORIZED, error.to_string())
        }
        AuthError::InvalidPasswordLength => ApiError::bad_request(error.to_string()),
        AuthError::AlreadyRegistered => {
            ApiError::new(StatusCode::CONFLICT, error.to_string())
        }
        AuthError::Internal => {
            ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "认证服务内部错误")
        }
    }
}

fn auth_status_body(registered: bool, authenticated: bool, lan_allowed: bool) -> Value {
    json!({
        "registered": registered,
        "authenticated": authenticated,
        "lanAllowed": lan_allowed,
    })
}

fn with_session_cookie(mut response: Response, cookie: String) -> Response {
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

pub async fn auth_status(
    State(state): State<AppState>,
    axum::Extension(client): axum::Extension<crate::net::ClientIp>,
    headers: HeaderMap,
) -> Json<Value> {
    let authenticated = match auth::session_from_headers(&headers) {
        Some(token) => state.auth.is_authenticated(&token).await,
        None => false,
    };
    let lan_allowed = {
        let lan_only = *state.lan_only.read().await;
        !lan_only || crate::net::is_internal(client.0)
    };
    Json(auth_status_body(
        state.auth.has_password().await,
        authenticated,
        lan_allowed,
    ))
}

pub async fn auth_register(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<PasswordRequest>,
) -> Result<Response, ApiError> {
    auth::validate_password(&request.password).map_err(auth_error_response)?;
    let _guard = state.auth.registration_lock().await;
    if state.auth.has_password().await {
        return Err(auth_error_response(AuthError::AlreadyRegistered));
    }
    let hash = AuthService::hash_password(&request.password)
        .await
        .map_err(auth_error_response)?;
    state
        .core
        .set_setting(auth::AUTH_SETTING_KEY, &hash)
        .await?;
    state.auth.install_password_hash(hash).await;
    let token = state.auth.create_session().await;
    tracing::info!("site access password registered");
    let secure = auth::request_is_secure(&headers);
    let response = Json(auth_status_body(true, true, true)).into_response();
    Ok(with_session_cookie(
        response,
        auth::session_cookie(&token, secure),
    ))
}

pub async fn auth_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<PasswordRequest>,
) -> Result<Response, ApiError> {
    if request.password.is_empty() {
        return Err(ApiError::bad_request("请输入访问密码"));
    }
    let token = state
        .auth
        .login(&request.password)
        .await
        .map_err(auth_error_response)?;
    let secure = auth::request_is_secure(&headers);
    let response = Json(auth_status_body(true, true, true)).into_response();
    Ok(with_session_cookie(
        response,
        auth::session_cookie(&token, secure),
    ))
}

pub async fn auth_logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if let Some(token) = auth::session_from_headers(&headers) {
        state.auth.logout(&token).await;
    }
    let secure = auth::request_is_secure(&headers);
    with_session_cookie(
        Json(json!({ "ok": true })).into_response(),
        auth::clear_session_cookie(secure),
    )
}

#[derive(Debug, Deserialize)]
pub struct LogsQuery {
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub contains: Option<String>,
}

pub async fn logs(
    State(state): State<AppState>,
    Query(query): Query<LogsQuery>,
) -> Json<Value> {
    let entries = state.logs.list(
        query.limit.unwrap_or(300),
        query.level.as_deref(),
        query.contains.as_deref(),
    );
    Json(json!({
        "entries": entries,
        "total": state.logs.len(),
    }))
}

pub async fn clear_logs(State(state): State<AppState>) -> Json<Value> {
    state.logs.clear();
    Json(json!({ "ok": true }))
}

pub async fn server_info(
    State(state): State<AppState>,
) -> Json<crate::metrics::ServerInfo> {
    Json(state.metrics.snapshot())
}

#[derive(Debug, Deserialize)]
pub struct TranscodeStatusQuery {
    #[serde(default)]
    pub refresh: Option<String>,
}

pub async fn transcode_status(
    State(state): State<AppState>,
    Query(query): Query<TranscodeStatusQuery>,
) -> ApiResult<crate::transcode::TranscodeStatus> {
    let refresh = matches!(
        query.refresh.as_deref(),
        Some("1" | "true" | "yes" | "on")
    );
    Ok(Json(state.transcode.status(refresh).await))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscodePathRequest {
    #[serde(default)]
    pub path: Option<String>,
}

pub async fn transcode_set_path(
    State(state): State<AppState>,
    Json(request): Json<TranscodePathRequest>,
) -> ApiResult<crate::transcode::TranscodeStatus> {
    let status = state
        .transcode
        .set_path(request.path)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(status))
}

pub async fn transcode_self_test(
    State(state): State<AppState>,
) -> ApiResult<crate::transcode::TranscodeStatus> {
    let status = state.transcode.deep_check().await;
    tracing::info!(
        found = status.found,
        devices = status.devices.len(),
        "ffmpeg hardware self-test finished"
    );
    Ok(Json(status))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedTranscodeStatus {
    pub status: Option<crate::transcode::TranscodeStatus>,
}

pub async fn transcode_cached(
    State(state): State<AppState>,
) -> ApiResult<CachedTranscodeStatus> {
    Ok(Json(CachedTranscodeStatus {
        status: state.transcode.cached().await,
    }))
}

pub async fn transcode_scan(
    State(state): State<AppState>,
    Json(request): Json<crate::transcode::ScanRequest>,
) -> ApiResult<crate::transcode::ScanResult> {
    ensure_allowed_path(&state, Path::new(&request.directory))?;
    let result = state
        .transcode
        .scan(request)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(result))
}

pub async fn transcode_scan_progress(
    State(state): State<AppState>,
) -> Json<crate::transcode::ScanProgress> {
    Json(state.transcode.scan_progress().await)
}

pub async fn transcode_jobs(
    State(state): State<AppState>,
) -> ApiResult<Vec<crate::transcode::JobView>> {
    Ok(Json(state.transcode.list_jobs().await))
}

pub async fn transcode_create_jobs(
    State(state): State<AppState>,
    Json(request): Json<crate::transcode::CreateJobsRequest>,
) -> ApiResult<Vec<crate::transcode::JobView>> {
    for file in &request.files {
        ensure_allowed_path(&state, Path::new(file))?;
    }
    if let Some(directory) = request.settings.output_dir.as_deref() {
        if !directory.trim().is_empty() {
            ensure_allowed_path(&state, Path::new(directory.trim()))?;
        }
    }
    let jobs = state
        .transcode
        .create_jobs(request)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(jobs))
}

pub async fn transcode_cancel_job(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Value> {
    state
        .transcode
        .cancel_job(&id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn transcode_retry_job(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Vec<crate::transcode::JobView>> {
    let jobs = state
        .transcode
        .retry_job(&id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(jobs))
}

pub async fn transcode_clear_jobs(
    State(state): State<AppState>,
) -> ApiResult<Value> {
    let removed = state.transcode.clear_finished_jobs().await;
    Ok(Json(json!({ "removed": removed })))
}

pub async fn transcode_stats(
    State(state): State<AppState>,
) -> Json<crate::transcode::TranscodeStats> {
    let info = state.metrics.snapshot();
    let gpus = crate::transcode::gpu_usage().await;
    Json(crate::transcode::TranscodeStats {
        cpu_usage_percent: info.cpu_usage_percent,
        memory_used_bytes: info.memory_used_bytes,
        memory_total_bytes: info.memory_total_bytes,
        gpus,
        sampled_at: chrono::Utc::now().timestamp_millis(),
    })
}

pub async fn transcode_events(
    State(state): State<AppState>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let receiver = state.transcode.subscribe_jobs();
    let stream = BroadcastStream::new(receiver).filter_map(|message| async move {
        let event = message.ok()?;
        let data = serde_json::to_string(&event).ok()?;
        Some(Ok(Event::default().data(data)))
    });
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("keep-alive"),
    )
}

pub async fn images_scan(
    State(state): State<AppState>,
    Json(request): Json<crate::images::ImageScanRequest>,
) -> ApiResult<crate::images::ImageScanResult> {
    ensure_allowed_path(&state, Path::new(&request.directory))?;
    let result = state
        .images
        .scan(request)
        .await
        .map_err(ApiError::bad_request)?;
    tracing::info!(
        directory = %result.directory,
        scanned = result.scanned,
        matched = result.matched,
        skipped_by_size = result.skipped_by_size,
        errors = result.errors.len(),
        took_ms = result.took_ms,
        "image scan finished"
    );
    Ok(Json(result))
}

pub async fn images_jobs(
    State(state): State<AppState>,
) -> ApiResult<Vec<crate::images::ImageJobView>> {
    Ok(Json(state.images.list().await))
}

pub async fn images_create_jobs(
    State(state): State<AppState>,
    Json(request): Json<crate::images::CreateImageJobsRequest>,
) -> ApiResult<Vec<crate::images::ImageJobView>> {
    for file in &request.files {
        ensure_allowed_path(&state, Path::new(file))?;
    }
    if let Some(directory) = request.output_dir.as_deref() {
        if !directory.trim().is_empty() {
            ensure_allowed_path(&state, Path::new(directory.trim()))?;
        }
    }
    let jobs = state
        .images
        .create_jobs(request)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(jobs))
}

pub async fn images_cancel_job(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Value> {
    state
        .images
        .cancel(&id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn images_retry_job(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Vec<crate::images::ImageJobView>> {
    let jobs = state
        .images
        .retry(&id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(jobs))
}

pub async fn images_clear_jobs(State(state): State<AppState>) -> ApiResult<Value> {
    let removed = state.images.clear_finished().await;
    Ok(Json(json!({ "removed": removed })))
}

pub async fn images_events(
    State(state): State<AppState>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let receiver = state.images.subscribe();
    let stream = BroadcastStream::new(receiver).filter_map(|message| async move {
        let event = message.ok()?;
        let data = serde_json::to_string(&event).ok()?;
        Some(Ok(Event::default().data(data)))
    });
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("keep-alive"),
    )
}

#[derive(Debug, Deserialize)]
pub struct HistoryQuery {
    #[serde(default)]
    pub limit: Option<usize>,
}

pub async fn history(
    State(state): State<AppState>,
    Query(query): Query<HistoryQuery>,
) -> ApiResult<Vec<crate::history::HistoryRecord>> {
    Ok(Json(
        state.history.list(query.limit.unwrap_or(100)).await,
    ))
}

pub async fn clear_history(State(state): State<AppState>) -> ApiResult<Value> {
    let removed = state.history.clear().await;
    Ok(Json(json!({ "removed": removed })))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VolumeView {
    id: String,
    name: String,
    path: String,
    exists: bool,
    writable: bool,
    total_bytes: u64,
    free_bytes: u64,
}

fn volume_view(volume: &VolumeConfig) -> VolumeView {
    let path = PathBuf::from(&volume.path);
    let exists = path.is_dir();
    let (total_bytes, free_bytes) = if exists {
        storage::capacity(&path)
    } else {
        (0, 0)
    };
    VolumeView {
        id: volume.id.clone(),
        name: volume.name.clone(),
        path: volume.path.clone(),
        exists,
        writable: exists && storage::probe_writable(&path),
        total_bytes,
        free_bytes,
    }
}

pub async fn volumes(State(state): State<AppState>) -> Json<Value> {
    let volumes = state
        .config
        .volumes
        .iter()
        .map(volume_view)
        .collect::<Vec<_>>();
    Json(json!({ "volumes": volumes }))
}

/// All filesystem roots (Windows drive letters / Unix mounts).
pub async fn storage_roots(State(state): State<AppState>) -> Json<Value> {
    if state.config.fnos_mode {
        let roots = storage::limited_roots(&state.config.allowed_paths);
        let home = roots
            .first()
            .map(|root| root.path.clone())
            .unwrap_or_default();
        Json(json!({ "roots": roots, "home": home }))
    } else {
        Json(json!({
            "roots": storage::roots(),
            "home": storage::home_dir().to_string_lossy(),
        }))
    }
}

#[derive(Debug, Deserialize)]
pub struct StorageBrowseQuery {
    #[serde(default)]
    pub path: Option<String>,
}

pub async fn storage_browse(
    State(state): State<AppState>,
    Query(query): Query<StorageBrowseQuery>,
) -> ApiResult<Value> {
    let result = storage::browse_scoped(query.path.as_deref(), allowed_scope(&state))
        .map_err(ApiError::bad_request)?;
    Ok(Json(json!(result)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageMkdirRequest {
    pub path: String,
    pub name: String,
}

pub async fn storage_mkdir(
    State(state): State<AppState>,
    Json(request): Json<StorageMkdirRequest>,
) -> ApiResult<Value> {
    let path = storage::create_folder_scoped(
        &request.path,
        &request.name,
        allowed_scope(&state),
    )
    .map_err(ApiError::bad_request)?;
    Ok(Json(json!({ "path": path })))
}

#[derive(Debug, Deserialize)]
pub struct StorageFilesQuery {
    #[serde(default)]
    pub path: Option<String>,
}

/// Full server file browser (directories + files).
pub async fn storage_files(
    State(state): State<AppState>,
    Query(query): Query<StorageFilesQuery>,
) -> ApiResult<Value> {
    let result = storage::browse_files_scoped(query.path.as_deref(), allowed_scope(&state))
        .map_err(ApiError::bad_request)?;
    Ok(Json(json!(result)))
}

#[derive(Debug, Deserialize)]
pub struct StorageFileQuery {
    pub path: String,
}

/// Stream any regular server file to the browser as an attachment.
pub async fn storage_file(
    State(state): State<AppState>,
    Query(query): Query<StorageFileQuery>,
) -> Result<Response, ApiError> {
    let path = storage::resolve_file_scoped(&query.path, allowed_scope(&state))
        .map_err(ApiError::bad_request)?;
    tracing::info!(path = %path.display(), "server file sent to browser");
    stream_file(path, None).await
}

/// Completed downloads performed by the server (Quark -> local disk).
pub async fn downloads(State(state): State<AppState>) -> ApiResult<Vec<TransferView>> {
    let mut items = state.core.list_transfers(1000).await?;
    items.retain(|item| {
        item.kind == "download"
            && item.status == "done"
            && !item.id.starts_with("privacy:")
    });
    Ok(Json(items))
}

/// Send a server-side completed download back to the browser.
pub async fn download_file(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Response, ApiError> {
    let transfer = state
        .core
        .get_transfer(&id)
        .await?
        .ok_or_else(|| ApiError::not_found("下载记录不存在"))?;
    if transfer.kind != "download" || transfer.status != "done" {
        return Err(ApiError::bad_request("该任务不是已完成的下载"));
    }
    tracing::info!(
        id = %id,
        path = %transfer.local_path,
        "completed download sent to browser"
    );
    let path = storage::resolve_file(&transfer.local_path).map_err(ApiError::bad_request)?;
    stream_file(path, Some(transfer.remote_name)).await
}

pub async fn speedtest_ping() -> Json<Value> {
    Json(json!({ "ok": true, "now": chrono::Utc::now().timestamp_millis() }))
}

#[derive(Debug, Deserialize)]
pub struct SpeedTestQuery {
    #[serde(default)]
    pub bytes: Option<u64>,
}

const SPEEDTEST_CHUNK: usize = 64 * 1024;

/// Stream pseudo-random bytes to measure browser -> server download speed.
pub async fn speedtest_download(Query(query): Query<SpeedTestQuery>) -> Response {
    let total = query
        .bytes
        .unwrap_or(25 * 1024 * 1024)
        .clamp(1024 * 1024, 256 * 1024 * 1024) as usize;
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut buffer = vec![0_u8; SPEEDTEST_CHUNK];
    for byte in buffer.iter_mut() {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        *byte = state as u8;
    }
    let chunk = Bytes::from(buffer);
    let chunks = total.div_ceil(SPEEDTEST_CHUNK);
    let last_len = total - (chunks - 1) * SPEEDTEST_CHUNK;
    let stream = futures_util::stream::iter((0..chunks).map(move |index| {
        let len = if index + 1 == chunks {
            last_len
        } else {
            SPEEDTEST_CHUNK
        };
        Ok::<Bytes, Infallible>(chunk.slice(0..len))
    }));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, total.to_string())
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Accel-Buffering", "no")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

/// Consume a browser upload and report the number of bytes received.
pub async fn speedtest_upload(body: Body) -> ApiResult<Value> {
    let started = Instant::now();
    let mut stream = body.into_data_stream();
    let mut bytes = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| ApiError::bad_request(error.to_string()))?;
        bytes += chunk.len() as u64;
    }
    Ok(Json(json!({
        "bytes": bytes,
        "elapsedMs": started.elapsed().as_millis(),
    })))
}

async fn stream_file(
    path: PathBuf,
    download_name: Option<String>,
) -> Result<Response, ApiError> {
    let metadata = tokio::fs::metadata(&path).await?;
    if !metadata.is_file() {
        return Err(ApiError::bad_request("目标不是普通文件"));
    }
    let name = download_name
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            path.file_name()
                .map(|value| value.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "download.bin".to_string());
    let ascii_name: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let encoded_name = utf8_percent_encode(&name, NON_ALPHANUMERIC).to_string();
    let content_type = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();
    let file = tokio::fs::File::open(&path).await?;
    let body = Body::from_stream(ReaderStream::new(file));
    let mut response = Response::new(body);
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&metadata.len().to_string())
            .unwrap_or_else(|_| HeaderValue::from_static("0")),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    let disposition = format!(
        "attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded_name}"
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&disposition)
            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );
    Ok(response)
}

async fn settings_json(state: &AppState, settings: &Settings) -> Result<Value, ApiError> {
    let mut value = serde_json::to_value(settings)
        .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "lanOnly".to_string(),
            Value::Bool(*state.lan_only.read().await),
        );
        object.insert("fnosMode".to_string(), Value::Bool(state.config.fnos_mode));
    }
    Ok(value)
}

pub async fn bootstrap(State(state): State<AppState>) -> ApiResult<Value> {
    let bootstrap = state.core.bootstrap().await?;
    let volumes = state
        .config
        .volumes
        .iter()
        .map(volume_view)
        .collect::<Vec<_>>();
    Ok(Json(json!({
        "accounts": bootstrap.accounts,
        "settings": settings_json(&state, &bootstrap.settings).await?,
        "transfers": bootstrap.transfers,
        "defaultParentFid": bootstrap.default_parent_fid,
        "dataDir": state.config.data_dir.to_string_lossy(),
        "volumes": volumes,
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieLoginRequest {
    pub cookie: String,
}

pub async fn login_with_cookie(
    State(state): State<AppState>,
    Json(request): Json<CookieLoginRequest>,
) -> ApiResult<AccountView> {
    if request.cookie.trim().is_empty() {
        return Err(ApiError::bad_request("Cookie 不能为空"));
    }
    Ok(Json(
        state.core.login_with_cookie(request.cookie.trim()).await?,
    ))
}

pub async fn start_qr_login(State(state): State<AppState>) -> ApiResult<Value> {
    let start = state.core.start_qr_login().await?;
    Ok(Json(json!({
        "sessionId": start.session_id,
        "qrUrl": start.qr_url,
        "expiresAt": start.expires_at,
    })))
}

pub async fn poll_qr_login(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
) -> ApiResult<Value> {
    let result = state.core.poll_qr_login(&session_id).await?;
    Ok(Json(json!({
        "state": result.state,
        "expiresAt": result.expires_at,
        "account": result.account,
        "message": result.message,
    })))
}

pub async fn cancel_qr_login(
    State(state): State<AppState>,
    AxumPath(session_id): AxumPath<String>,
) -> ApiResult<Value> {
    state.core.cancel_qr_login(&session_id).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn accounts(State(state): State<AppState>) -> ApiResult<Vec<AccountView>> {
    Ok(Json(state.core.accounts().await?))
}

pub async fn refresh_account(
    State(state): State<AppState>,
    AxumPath(account_id): AxumPath<String>,
) -> ApiResult<AccountView> {
    Ok(Json(state.core.refresh_account(&account_id).await?))
}

pub async fn logout(
    State(state): State<AppState>,
    AxumPath(account_id): AxumPath<String>,
) -> ApiResult<Value> {
    state.core.logout(&account_id).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    pub account_id: String,
    #[serde(default)]
    pub parent_fid: Option<String>,
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub size: Option<u32>,
}

pub async fn list_dir(
    State(state): State<AppState>,
    Query(query): Query<ListQuery>,
) -> ApiResult<Value> {
    let parent_fid = query.parent_fid.unwrap_or_else(|| "0".to_string());
    let page = query.page.unwrap_or(1).max(1);
    let size = query.size.unwrap_or(100).clamp(1, 200);
    let result = state
        .core
        .list_dir(&query.account_id, &parent_fid, page, size)
        .await?;
    Ok(Json(json!({
        "entries": result.entries,
        "total": result.total,
        "page": result.page,
        "size": result.size,
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MkdirRequest {
    pub account_id: String,
    pub parent_fid: String,
    pub name: String,
}

pub async fn mkdir(
    State(state): State<AppState>,
    Json(request): Json<MkdirRequest>,
) -> ApiResult<Value> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("文件夹名称不能为空"));
    }
    let fid = state
        .core
        .mkdir(&request.account_id, &request.parent_fid, name)
        .await?;
    Ok(Json(json!({ "fid": fid })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameRequest {
    pub account_id: String,
    pub fid: String,
    pub name: String,
}

pub async fn rename(
    State(state): State<AppState>,
    Json(request): Json<RenameRequest>,
) -> ApiResult<Value> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("文件名不能为空"));
    }
    state
        .core
        .rename(&request.account_id, &request.fid, name)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveRequest {
    pub account_id: String,
    pub fids: Vec<String>,
    pub parent_fid: String,
}

pub async fn move_files(
    State(state): State<AppState>,
    Json(request): Json<MoveRequest>,
) -> ApiResult<Value> {
    state
        .core
        .move_files(&request.account_id, &request.fids, &request.parent_fid)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRequest {
    pub account_id: String,
    pub fids: Vec<String>,
    #[serde(default)]
    pub permanent: bool,
}

pub async fn delete_files(
    State(state): State<AppState>,
    Json(request): Json<DeleteRequest>,
) -> ApiResult<Value> {
    state
        .core
        .delete_files(&request.account_id, &request.fids, request.permanent)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleQuery {
    pub account_id: String,
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub size: Option<u32>,
}

pub async fn list_recycle(
    State(state): State<AppState>,
    Query(query): Query<RecycleQuery>,
) -> ApiResult<Value> {
    let result = state
        .core
        .list_recycle(
            &query.account_id,
            query.page.unwrap_or(1).max(1),
            query.size.unwrap_or(100).clamp(1, 200),
        )
        .await?;
    Ok(Json(json!({
        "entries": result.entries,
        "total": result.total,
        "page": result.page,
        "size": result.size,
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleActionRequest {
    pub account_id: String,
    #[serde(default)]
    pub record_ids: Vec<String>,
}

pub async fn restore_recycle(
    State(state): State<AppState>,
    Json(request): Json<RecycleActionRequest>,
) -> ApiResult<Value> {
    state
        .core
        .restore_recycle(&request.account_id, &request.record_ids)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete_recycle(
    State(state): State<AppState>,
    Json(request): Json<RecycleActionRequest>,
) -> ApiResult<Value> {
    state
        .core
        .delete_recycle(&request.account_id, &request.record_ids)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn clear_recycle(
    State(state): State<AppState>,
    Json(request): Json<RecycleActionRequest>,
) -> ApiResult<Value> {
    let removed = state.core.clear_recycle(&request.account_id).await?;
    Ok(Json(json!({ "removed": removed })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub account_id: String,
    /// Preferred: an absolute directory anywhere on the server.
    #[serde(default)]
    pub dest_dir: Option<String>,
    /// Backwards-compatible configured-volume selection.
    #[serde(default)]
    pub volume_id: Option<String>,
    #[serde(default)]
    pub dest_path: Option<String>,
    pub items: Vec<DownloadItem>,
}

fn resolve_dest(volume: &VolumeConfig, relative: Option<&str>) -> Result<PathBuf, ApiError> {
    let root = PathBuf::from(&volume.path);
    if !root.is_dir() {
        return Err(ApiError::bad_request(format!(
            "存储盘目录不存在: {}",
            root.display()
        )));
    }
    let relative = relative.unwrap_or("").trim();
    let relative = relative.trim_start_matches(['/', '\\']);
    let mut dest = root.clone();
    if !relative.is_empty() {
        let candidate = Path::new(relative);
        if candidate.is_absolute() {
            return Err(ApiError::bad_request("目标目录必须是相对路径"));
        }
        for component in candidate.components() {
            match component {
                Component::Normal(part) => dest.push(part),
                Component::CurDir => {}
                _ => return Err(ApiError::bad_request("目标目录不能包含 ..")),
            }
        }
    }
    std::fs::create_dir_all(&dest)?;
    Ok(dest)
}

pub async fn enqueue_download(
    State(state): State<AppState>,
    Json(request): Json<DownloadRequest>,
) -> ApiResult<Value> {
    if request.items.is_empty() {
        return Err(ApiError::bad_request("没有选择文件"));
    }
    let dest = if let Some(directory) = request
        .dest_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        storage::resolve_destination_scoped(directory, allowed_scope(&state))
            .map_err(ApiError::bad_request)?
    } else if let Some(volume_id) = request
        .volume_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        let volume = state
            .config
            .volume(volume_id)
            .ok_or_else(|| ApiError::not_found("存储盘不存在"))?;
        resolve_dest(volume, request.dest_path.as_deref())?
    } else {
        let default_dir = state.core.settings().await.download_dir;
        storage::resolve_destination_scoped(&default_dir, allowed_scope(&state))
            .map_err(ApiError::bad_request)?
    };
    ensure_allowed_path(&state, &dest)?;
    let ids = state
        .core
        .enqueue_download(
            &request.account_id,
            request.items,
            Some(dest.to_string_lossy().to_string()),
        )
        .await?;
    tracing::info!(
        account = %request.account_id,
        dest = %dest.display(),
        tasks = ids.len(),
        "download tasks enqueued"
    );
    Ok(Json(json!({ "ids": ids, "dest": dest.to_string_lossy() })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferQuery {
    #[serde(default)]
    pub limit: Option<i64>,
}

pub async fn list_transfers(
    State(state): State<AppState>,
    Query(query): Query<TransferQuery>,
) -> ApiResult<Vec<TransferView>> {
    Ok(Json(
        state
            .core
            .list_transfers(query.limit.unwrap_or(300).clamp(1, 1000))
            .await?,
    ))
}

pub async fn transfer_action(
    State(state): State<AppState>,
    AxumPath((id, action)): AxumPath<(String, String)>,
) -> ApiResult<Value> {
    match action.as_str() {
        "pause" => state.core.pause_transfer(&id).await?,
        "resume" => state.core.resume_transfer(&id).await?,
        "retry" => state.core.retry_transfer(&id).await?,
        "cancel" => state.core.cancel_transfer(&id).await?,
        other => {
            return Err(ApiError::bad_request(format!(
                "未知的传输操作: {other}"
            )))
        }
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn remove_transfer(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Value> {
    state.core.remove_transfer(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn clear_transfers(State(state): State<AppState>) -> ApiResult<Value> {
    state.core.clear_finished_transfers().await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn get_settings(State(state): State<AppState>) -> ApiResult<Value> {
    let settings = state.core.settings().await;
    Ok(Json(settings_json(&state, &settings).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsRequest {
    /// Absolute default download directory. `downloadDir` in JSON.
    #[serde(default)]
    pub download_dir: Option<String>,
    #[serde(default)]
    pub concurrency: Option<u32>,
    #[serde(default)]
    pub max_speed_bps: Option<u64>,
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(default)]
    pub lan_only: Option<bool>,
}

pub async fn update_settings(
    State(state): State<AppState>,
    Json(request): Json<UpdateSettingsRequest>,
) -> ApiResult<Value> {
    if let Some(lan_only) = request.lan_only {
        state
            .core
            .set_setting("web_lan_only", if lan_only { "true" } else { "false" })
            .await?;
        *state.lan_only.write().await = lan_only;
    }
    let download_dir = match request
        .download_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(directory) => Some(
            storage::resolve_destination_scoped(directory, allowed_scope(&state))
                .map_err(ApiError::bad_request)?
                .to_string_lossy()
                .to_string(),
        ),
        None => None,
    };
    let settings = state
        .core
        .update_settings(
            download_dir,
            request.concurrency,
            request.max_speed_bps,
            request.theme,
        )
        .await?;
    tracing::info!(
        concurrency = settings.concurrency,
        download_dir = %settings.download_dir,
        theme = %settings.theme,
        "settings updated"
    );
    Ok(Json(settings_json(&state, &settings).await?))
}

/// Aggregated transfer/account events for the browser.
pub async fn events(
    State(state): State<AppState>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let receiver = state.core.subscribe();
    let stream = BroadcastStream::new(receiver).filter_map(|message| async move {
        let event = message.ok()?;
        let data = serde_json::to_string(&event).ok()?;
        Some(Ok(Event::default().data(data)))
    });
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("keep-alive"),
    )
}

/// Diagnostics endpoint used by the UI when a download lands on a slow volume.
pub async fn volume_usage(State(state): State<AppState>) -> Json<Value> {
    let mut usage = BTreeMap::new();
    for volume in &state.config.volumes {
        let path = PathBuf::from(&volume.path);
        let (total, free) = storage::capacity(&path);
        usage.insert(
            volume.id.clone(),
            json!({ "total": total, "free": free }),
        );
    }
    Json(json!({ "usage": usage }))
}
