mod codecs;
mod command;
mod exec;
mod gpu;
mod job;
mod media;
mod probe;
mod self_test;
mod usage;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, Mutex, RwLock};

use quark_core::AppCore;

use media::MediaFile;

pub use command::TranscodeSettings;
pub use job::{JobView, TranscodeEvent};
pub use media::ScanResult;
pub use probe::TranscodeStatus;
pub use usage::{GpuUsage, TranscodeStats};

pub const SETTING_FFMPEG_PATH: &str = "ffmpeg_path";
pub const SETTING_PROBE: &str = "transcode_probe";

/// Cache fast detection for a short while: probing executes FFmpeg several
/// times, and the transcode page polls on open rather than continuously.
const CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRequest {
    pub directory: String,
    #[serde(default = "default_true")]
    pub recursive: bool,
    #[serde(default)]
    pub source_codec: Option<String>,
    /// Only inspect videos larger than this size. `None` / 0 = unlimited.
    #[serde(default)]
    pub min_size_bytes: Option<u64>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateJobsRequest {
    pub files: Vec<String>,
    #[serde(flatten)]
    pub settings: TranscodeSettings,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub running: bool,
    pub directory: String,
    pub processed: usize,
    pub total: usize,
    pub matched: usize,
    pub errors: usize,
    pub skipped_by_size: usize,
    pub cache_hits: usize,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub took_ms: u64,
    pub error: Option<String>,
}

pub struct ScanTracker {
    state: RwLock<ScanProgress>,
}

impl ScanTracker {
    pub fn new() -> Self {
        Self {
            state: RwLock::new(ScanProgress::default()),
        }
    }

    async fn reset(&self, directory: &str) {
        let mut state = self.state.write().await;
        *state = ScanProgress {
            running: true,
            directory: directory.to_string(),
            started_at: chrono::Utc::now().timestamp_millis(),
            ..ScanProgress::default()
        };
    }

    async fn begin(&self, total: usize, skipped_by_size: usize) {
        let mut state = self.state.write().await;
        state.total = total;
        state.skipped_by_size = skipped_by_size;
        state.running = true;
    }

    pub async fn advance(&self, cache_hit: bool) {
        let mut state = self.state.write().await;
        state.processed = state.processed.saturating_add(1);
        if cache_hit {
            state.cache_hits = state.cache_hits.saturating_add(1);
        }
    }

    async fn finish(&self, matched: usize, errors: usize, took_ms: u64) {
        let mut state = self.state.write().await;
        state.running = false;
        state.matched = matched;
        state.errors = errors;
        state.took_ms = took_ms;
        state.finished_at = Some(chrono::Utc::now().timestamp_millis());
        state.error = None;
    }

    async fn fail(&self, error: String) {
        let mut state = self.state.write().await;
        state.running = false;
        state.finished_at = Some(chrono::Utc::now().timestamp_millis());
        state.error = Some(error);
    }

    pub async fn snapshot(&self) -> ScanProgress {
        self.state.read().await.clone()
    }
}

impl Default for ScanTracker {
    fn default() -> Self {
        Self::new()
    }
}

pub struct TranscodeService {
    core: AppCore,
    custom: RwLock<Option<String>>,
    persisted: RwLock<Option<TranscodeStatus>>,
    cache: RwLock<Option<CachedStatus>>,
    probe_lock: Mutex<()>,
    scan_lock: Mutex<()>,
    scan_tracker: Arc<ScanTracker>,
    jobs: job::JobManager,
    scan_cache: RwLock<HashMap<String, MediaFile>>,
    history: Arc<crate::history::HistoryService>,
}

struct CachedStatus {
    at: Instant,
    status: TranscodeStatus,
}

impl TranscodeService {
    pub fn new(
        core: AppCore,
        custom: Option<String>,
        persisted: Option<String>,
        history: Arc<crate::history::HistoryService>,
    ) -> Self {
        let custom = custom
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let persisted = persisted.and_then(|json| {
            match serde_json::from_str::<TranscodeStatus>(&json) {
                Ok(status) => Some(status),
                Err(error) => {
                    tracing::warn!(%error, "忽略无法解析的 ffmpeg 检测缓存");
                    None
                }
            }
        });
        Self {
            core,
            custom: RwLock::new(custom),
            persisted: RwLock::new(persisted),
            cache: RwLock::new(None),
            probe_lock: Mutex::new(()),
            scan_lock: Mutex::new(()),
            scan_tracker: Arc::new(ScanTracker::new()),
            jobs: job::JobManager::new(),
            scan_cache: RwLock::new(HashMap::new()),
            history,
        }
    }

    /// Store the result in memory and SQLite so later page visits do not
    /// re-run detection automatically.
    async fn remember(&self, status: &TranscodeStatus) {
        *self.cache.write().await = Some(CachedStatus {
            at: Instant::now(),
            status: status.clone(),
        });
        *self.persisted.write().await = Some(status.clone());
        match serde_json::to_string(status) {
            Ok(json) => {
                if let Err(error) = self.core.set_setting(SETTING_PROBE, &json).await {
                    tracing::warn!(%error, "保存 ffmpeg 检测结果失败");
                }
            }
            Err(error) => tracing::warn!(%error, "序列化 ffmpeg 检测结果失败"),
        }
    }

    pub async fn status(&self, refresh: bool) -> TranscodeStatus {
        if !refresh {
            if let Some(cache) = self.cache.read().await.as_ref() {
                if cache.at.elapsed() < CACHE_TTL {
                    return cache.status.clone();
                }
            }
        }

        let custom = self.custom.read().await.clone();
        let _probe = self.probe_lock.lock().await;
        // Another request may have filled the cache while we waited.
        if !refresh {
            if let Some(cache) = self.cache.read().await.as_ref() {
                if cache.at.elapsed() < CACHE_TTL {
                    return cache.status.clone();
                }
            }
        }
        let status = probe::probe(custom.as_deref()).await;
        self.remember(&status).await;
        tracing::info!(
            found = status.found,
            path = ?status.path,
            version = ?status.version,
            gpus = status.gpus.len(),
            hwaccels = %status.hwaccels.join(","),
            codecs = status.codecs.len(),
            elapsed_ms = status.probe_ms,
            error = ?status.error,
            "ffmpeg probe finished"
        );
        status
    }

    /// Return the last detection result without running any process.
    pub async fn cached(&self) -> Option<TranscodeStatus> {
        if let Some(cache) = self.cache.read().await.as_ref() {
            return Some(cache.status.clone());
        }
        self.persisted.read().await.clone()
    }

    /// Persist a user-chosen ffmpeg binary. Passing `None` (or an empty string)
    /// restores automatic detection.
    pub async fn set_path(&self, path: Option<String>) -> Result<TranscodeStatus, String> {
        let path = path
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        if let Some(value) = path.as_deref() {
            let candidate = Path::new(value);
            if !candidate.is_absolute() {
                return Err("请填写 ffmpeg 可执行文件的绝对路径".to_string());
            }
            if !candidate.is_file() {
                return Err(format!("文件不存在：{value}"));
            }
            probe::validate(value).await?;
        }

        let stored = path.clone().unwrap_or_default();
        self.core
            .set_setting(SETTING_FFMPEG_PATH, &stored)
            .await
            .map_err(|error| format!("保存 ffmpeg 路径失败：{error}"))?;
        *self.custom.write().await = path.clone();

        let _probe = self.probe_lock.lock().await;
        let status = probe::probe(path.as_deref()).await;
        self.remember(&status).await;
        tracing::info!(
            path = ?status.path,
            found = status.found,
            "ffmpeg path probe finished"
        );
        Ok(status)
    }

    /// Re-probe and run one-frame encode tests for each hardware encoder.
    pub async fn deep_check(&self) -> TranscodeStatus {
        let mut status = match self.cached().await {
            Some(status) => status,
            None => self.status(false).await,
        };
        if status.found {
            if let Some(path) = status.path.clone() {
                self_test::run(Path::new(&path), &mut status).await;
                status.checked_at = chrono::Utc::now().timestamp_millis();
                self.remember(&status).await;
                for device in &status.devices {
                    tracing::info!(
                        accel = %device.accel,
                        available = device.available,
                        verified = ?device.verified,
                        note = ?device.note,
                        "hardware self-test result"
                    );
                }
            }
        }
        status
    }

    pub async fn scan(&self, request: ScanRequest) -> Result<ScanResult, String> {
        let status = self
            .cached()
            .await
            .ok_or_else(|| "请先点击“检测 ffmpeg”".to_string())?;
        if !status.found {
            return Err(status
                .error
                .unwrap_or_else(|| "未找到可用的 ffmpeg".to_string()));
        }
        let ffprobe = status
            .ffprobe_path
            .ok_or_else(|| "未找到 ffprobe，无法读取视频信息".to_string())?;
        tracing::info!(
            directory = %request.directory,
            recursive = request.recursive,
            source_codec = ?request.source_codec,
            min_size_bytes = ?request.min_size_bytes,
            "transcode scan started"
        );
        let _scan_guard = self.scan_lock.lock().await;
        self.scan_tracker.reset(&request.directory).await;
        let result = media::scan(
            Path::new(&ffprobe),
            &request.directory,
            request.recursive,
            request.source_codec.as_deref(),
            request.min_size_bytes.unwrap_or(0),
            Some(&self.scan_cache),
            Some(self.scan_tracker.clone()),
        )
        .await;
        let result = match result {
            Ok(result) => {
                self.scan_tracker
                    .finish(result.matched, result.errors.len(), result.took_ms)
                    .await;
                result
            }
            Err(error) => {
                self.scan_tracker.fail(error.clone()).await;
                return Err(error);
            }
        };
        tracing::info!(
            directory = %result.directory,
            scanned = result.scanned,
            matched = result.matched,
            skipped_by_size = result.skipped_by_size,
            errors = result.errors.len(),
            took_ms = result.took_ms,
            "transcode scan finished"
        );
        for error in result.errors.iter().take(5) {
            tracing::warn!(error = %error, "transcode scan file failed");
        }
        let mut cache = self.scan_cache.write().await;
        for file in &result.files {
            cache.insert(file.path.clone(), file.clone());
        }
        Ok(result)
    }

    pub async fn scan_progress(&self) -> ScanProgress {
        self.scan_tracker.snapshot().await
    }

    pub async fn create_jobs(&self, request: CreateJobsRequest) -> Result<Vec<JobView>, String> {
        let status = self
            .cached()
            .await
            .ok_or_else(|| "请先点击“检测 ffmpeg”".to_string())?;
        if !status.found {
            return Err(status
                .error
                .unwrap_or_else(|| "未找到可用的 ffmpeg".to_string()));
        }
        let ffmpeg = status
            .path
            .clone()
            .ok_or_else(|| "ffmpeg 路径为空".to_string())?;
        let ffprobe = status
            .ffprobe_path
            .clone()
            .ok_or_else(|| "未找到 ffprobe，无法读取视频信息".to_string())?;

        let mut seen = HashSet::new();
        let files: Vec<String> = request
            .files
            .into_iter()
            .map(|file| file.trim().to_string())
            .filter(|file| !file.is_empty() && seen.insert(file.clone()))
            .collect();
        if files.is_empty() {
            return Err("请先选择要转码的视频".to_string());
        }
        let mut settings = request.settings;
        settings.output_dir = match settings.output_dir {
            Some(directory) if !directory.trim().is_empty() => Some(
                crate::storage::resolve_destination(&directory)
                    .map_err(|error| format!("输出目录不可用：{error}"))?
                    .to_string_lossy()
                    .to_string(),
            ),
            _ => None,
        };

        tracing::info!(
            files = files.len(),
            target_codec = %settings.target_codec,
            container = %settings.container,
            encoder = %settings.encoder,
            resolution = %settings.resolution,
            bitrate_mode = %settings.bitrate_mode,
            crf = ?settings.crf,
            audio = %settings.audio,
            delete_original = settings.delete_original,
            output_dir = ?settings.output_dir,
            "transcode batch requested"
        );

        let mut items = Vec::new();
        let mut reserved = HashSet::new();
        for file in files {
            let path = PathBuf::from(&file);
            if !path.is_absolute() {
                return Err(format!("文件路径必须是绝对路径：{file}"));
            }
            if !path.is_file() {
                return Err(format!("文件不存在：{file}"));
            }
            let cached = self.scan_cache.read().await.get(&file).cloned();
            let media = match cached {
                Some(media) if file_unchanged(&path, &media) => media,
                _ => media::probe_file(Path::new(&ffprobe), &path)
                    .await
                    .map_err(|error| format!("无法读取 {}: {error}", path.display()))?
                    .ok_or_else(|| format!("不是有效的视频文件：{file}"))?,
            };
            let options = command::resolve(&media, &settings, &status)?;
            let output = command::output_path_reserving(&path, &options, &reserved)?;
            tracing::debug!(
                source = %media.path,
                output = %output.display(),
                source_codec = %media.video_codec,
                target_codec = %options.target_codec,
                container = %options.container,
                resolution = %options.resolution_label,
                encoder = %options.encoder,
                hardware = options.hardware,
                crf = ?options.crf,
                bitrate_kbps = options.bitrate_kbps,
                "transcode job prepared"
            );
            reserved.insert(output.clone());
            items.push((media, options, output));
        }

        let concurrency = settings.concurrency.unwrap_or(1);
        let quality = if settings
            .bitrate_mode
            .trim()
            .eq_ignore_ascii_case("crf")
        {
            format!("CRF {}", settings.crf.unwrap_or(0))
        } else if settings
            .bitrate_mode
            .trim()
            .eq_ignore_ascii_case("custom")
        {
            format!("{} kbps", settings.bitrate_kbps.unwrap_or(0))
        } else {
            "源码率".to_string()
        };
        let resolution = match settings.resolution.as_str() {
            "source" | "original" | "" => "原始分辨率".to_string(),
            "custom" => "自定义分辨率".to_string(),
            value => value.to_uppercase(),
        };
        let summary = format!(
            "{} · {} · {} · {} · {} · 并发 {}",
            settings.target_codec.to_uppercase(),
            settings.container.to_uppercase(),
            if settings.encoder.eq_ignore_ascii_case("auto") {
                "自动编码器"
            } else {
                settings.encoder.as_str()
            },
            resolution,
            quality,
            concurrency
        );
        tracing::info!(
            count = items.len(),
            concurrency = concurrency,
            "transcode jobs queued"
        );
        let batch_started_at = chrono::Utc::now().timestamp_millis();
        let created = self
            .jobs
            .create_jobs(PathBuf::from(ffmpeg), items, concurrency)
            .await?;
        if !created.is_empty() {
            let ids: HashSet<String> = created.iter().map(|job| job.id.clone()).collect();
            let manager = self.jobs.clone();
            let history = self.history.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    let all = manager.list().await;
                    let batch: Vec<JobView> = all
                        .into_iter()
                        .filter(|job| ids.contains(&job.id))
                        .collect();
                    if batch.is_empty() {
                        return;
                    }
                    if batch
                        .iter()
                        .any(|job| job.status == "queued" || job.status == "running")
                    {
                        continue;
                    }
                    let finished_at = chrono::Utc::now().timestamp_millis();
                    history
                        .add(crate::history::record_from_jobs(
                            "video",
                            summary,
                            batch_started_at,
                            finished_at,
                            &batch,
                        ))
                        .await;
                    return;
                }
            });
        }
        Ok(created)
    }

    pub async fn list_jobs(&self) -> Vec<JobView> {
        self.jobs.list().await
    }

    pub async fn cancel_job(&self, id: &str) -> Result<(), String> {
        self.jobs.cancel(id).await
    }

    pub async fn retry_job(&self, id: &str) -> Result<Vec<JobView>, String> {
        self.jobs.retry(id).await
    }

    pub async fn clear_finished_jobs(&self) -> usize {
        self.jobs.clear_finished().await
    }

    pub fn subscribe_jobs(&self) -> broadcast::Receiver<TranscodeEvent> {
        self.jobs.subscribe()
    }
}

pub async fn gpu_usage() -> Vec<GpuUsage> {
    usage::sample().await
}

fn file_unchanged(path: &Path, media: &MediaFile) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if metadata.len() != media.size_bytes {
        return false;
    }
    if media.modified_at == 0 {
        return true;
    }
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64 == media.modified_at)
        .unwrap_or(false)
}
