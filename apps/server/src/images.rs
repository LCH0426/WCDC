use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use futures_util::stream::{self, StreamExt};
use image::{AnimationDecoder, DynamicImage};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc, watch, Mutex, RwLock, Semaphore};
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir;
use zenwebp::mux::{AnimationConfig, AnimationEncoder};
use zenwebp::{
    EncodeRequest, EncoderConfig, LosslessConfig, LossyConfig, PixelLayout,
};

const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "jpe", "jfif", "png", "apng", "bmp", "gif", "tif", "tiff", "ico", "tga", "pnm",
    "ppm", "pgm", "pbm", "qoi", "hdr", "exr", "dds", "ff",
];

const SCAN_CONCURRENCY: usize = 4;
const DEFAULT_QUALITY: u8 = 80;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageScanRequest {
    pub directory: String,
    #[serde(default = "default_true")]
    pub recursive: bool,
    #[serde(default)]
    pub min_size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFile {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub modified_at: i64,
    pub format: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageScanResult {
    pub directory: String,
    pub scanned: usize,
    pub matched: usize,
    pub skipped_by_size: usize,
    pub files: Vec<ImageFile>,
    pub errors: Vec<String>,
    pub took_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageScanProgress {
    pub running: bool,
    pub directory: String,
    pub processed: usize,
    pub total: usize,
    pub matched: usize,
    pub errors: usize,
    pub skipped_by_size: usize,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub took_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateImageJobsRequest {
    pub files: Vec<String>,
    #[serde(default = "default_quality")]
    pub quality: u8,
    #[serde(default)]
    pub lossless: bool,
    #[serde(default = "default_concurrency")]
    pub concurrency: u32,
    #[serde(default)]
    pub cpu_threads: Option<u32>,
    #[serde(default = "default_true")]
    pub delete_original: bool,
    #[serde(default)]
    pub output_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageJobView {
    pub id: String,
    pub source_path: String,
    pub source_name: String,
    pub output_path: String,
    pub source_format: String,
    pub width: u32,
    pub height: u32,
    pub source_bytes: u64,
    pub output_bytes: u64,
    pub quality: u8,
    pub lossless: bool,
    pub delete_original: bool,
    pub status: String,
    pub progress: f64,
    pub frames: u32,
    pub error: Option<String>,
    pub note: Option<String>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ImageEvent {
    ImageJobUpdated { job: ImageJobView },
    ImageJobsCleared,
}

struct JobEntry {
    view: ImageJobView,
    quality: u8,
    lossless: bool,
    cancel: CancellationToken,
}

struct Inner {
    jobs: RwLock<HashMap<String, JobEntry>>,
    events: broadcast::Sender<ImageEvent>,
    paused: watch::Sender<bool>,
    persist_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedImageJob {
    id: String,
    source_path: String,
    output_path: String,
    width: u32,
    height: u32,
    source_bytes: u64,
    quality: u8,
    lossless: bool,
    delete_original: bool,
    created_at: i64,
}

#[derive(Clone)]
pub struct ImageService {
    inner: Arc<Inner>,
    data_dir: PathBuf,
    last_scan: Arc<RwLock<Option<ImageScanResult>>>,
    scan_lock: Arc<Mutex<()>>,
    scan_progress: Arc<RwLock<ImageScanProgress>>,
    history: Arc<crate::history::HistoryService>,
}

impl ImageService {
    pub fn new(history: Arc<crate::history::HistoryService>, data_dir: PathBuf) -> Self {
        let (events, _) = broadcast::channel(512);
        let (paused, _) = watch::channel(false);
        let last_scan = std::fs::read_to_string(data_dir.join("images-last-scan.json"))
            .ok()
            .and_then(|raw| match serde_json::from_str::<ImageScanResult>(&raw) {
                Ok(scan) => Some(scan),
                Err(error) => {
                    tracing::warn!(%error, "忽略无法解析的图片扫描缓存");
                    None
                }
            });
        Self {
            inner: Arc::new(Inner {
                jobs: RwLock::new(HashMap::new()),
                events,
                paused,
                persist_path: Some(data_dir.join("image-jobs.json")),
            }),
            data_dir,
            last_scan: Arc::new(RwLock::new(last_scan)),
            scan_lock: Arc::new(Mutex::new(())),
            scan_progress: Arc::new(RwLock::new(ImageScanProgress::default())),
            history,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ImageEvent> {
        self.inner.events.subscribe()
    }

    /// Run the scan in a detached task so switching tabs does not abort it.
    /// Progress and the final result are stored in the service.
    pub async fn scan(&self, request: ImageScanRequest) -> Result<ImageScanResult, String> {
        let service = self.clone();
        tokio::spawn(async move { service.scan_inner(request).await })
            .await
            .map_err(|error| format!("图片扫描任务异常退出: {error}"))?
    }

    async fn scan_inner(&self, request: ImageScanRequest) -> Result<ImageScanResult, String> {
        let _guard = self.scan_lock.lock().await;
        self.reset_scan_progress(&request.directory).await;
        let result = self.scan_work(request).await;
        match &result {
            Ok(scan) => self.finish_scan_progress(scan).await,
            Err(error) => self.fail_scan_progress(error).await,
        }
        result
    }

    async fn scan_work(&self, request: ImageScanRequest) -> Result<ImageScanResult, String> {
        let started = Instant::now();
        let directory = request.directory.trim();
        if directory.is_empty() {
            return Err("请填写要扫描的文件夹".to_string());
        }
        let directory_path = PathBuf::from(directory);
        if !directory_path.is_absolute() {
            return Err("扫描文件夹必须是绝对路径".to_string());
        }
        let metadata = std::fs::metadata(&directory_path)
            .map_err(|error| format!("无法读取文件夹 {}: {error}", directory_path.display()))?;
        if !metadata.is_dir() {
            return Err(format!("不是文件夹: {}", directory_path.display()));
        }

        let min_size_bytes = request.min_size_bytes.unwrap_or(0);
        tracing::info!(
            directory = %directory_path.display(),
            recursive = request.recursive,
            min_size_bytes,
            "image scan started"
        );
        let mut paths = Vec::new();
        let mut skipped_by_size = 0;
        let max_depth = if request.recursive { usize::MAX } else { 1 };
        for entry in WalkDir::new(&directory_path)
            .max_depth(max_depth)
            .follow_links(false)
            .into_iter()
            .flatten()
        {
            if !entry.file_type().is_file() || !has_image_extension(entry.path()) {
                continue;
            }
            if min_size_bytes > 0 {
                let size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
                if size <= min_size_bytes {
                    skipped_by_size += 1;
                    continue;
                }
            }
            paths.push(entry.into_path());
        }
        paths.sort();

        let scanned = paths.len();
        {
            let mut progress = self.scan_progress.write().await;
            progress.total = scanned;
            progress.skipped_by_size = skipped_by_size;
        }
        let progress_state = self.scan_progress.clone();
        let results = stream::iter(paths.into_iter().map(|path| {
            let progress = progress_state.clone();
            async move {
                let probe_path = path.clone();
                let result = tokio::task::spawn_blocking(move || image_metadata(&probe_path))
                    .await
                    .unwrap_or_else(|error| Err(format!("读取图片信息失败: {error}")));
                progress.write().await.processed += 1;
                (path, result)
            }
        }))
        .buffer_unordered(SCAN_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;

        let mut files = Vec::new();
        let mut errors = Vec::new();
        for (path, result) in results {
            match result {
                Ok(file) => files.push(file),
                Err(error) => {
                    if errors.len() < 20 {
                        errors.push(format!("{}: {error}", path.display()));
                    }
                }
            }
        }
        files.sort_by(|left, right| left.path.cmp(&right.path));

        let result = ImageScanResult {
            directory: directory_path.to_string_lossy().to_string(),
            scanned,
            matched: files.len(),
            skipped_by_size,
            files,
            errors,
            took_ms: started.elapsed().as_millis() as u64,
        };
        *self.last_scan.write().await = Some(result.clone());
        if let Err(error) = self.save_last_scan(&result).await {
            tracing::warn!(%error, "保存图片扫描缓存失败");
        }
        Ok(result)
    }

    async fn reset_scan_progress(&self, directory: &str) {
        let mut progress = self.scan_progress.write().await;
        *progress = ImageScanProgress {
            running: true,
            directory: directory.trim().to_string(),
            started_at: now_ms(),
            ..ImageScanProgress::default()
        };
    }

    async fn finish_scan_progress(&self, result: &ImageScanResult) {
        let mut progress = self.scan_progress.write().await;
        progress.running = false;
        progress.directory = result.directory.clone();
        progress.processed = result.scanned;
        progress.total = result.scanned;
        progress.matched = result.matched;
        progress.errors = result.errors.len();
        progress.skipped_by_size = result.skipped_by_size;
        progress.took_ms = result.took_ms;
        progress.finished_at = Some(now_ms());
        progress.error = None;
    }

    async fn fail_scan_progress(&self, error: &str) {
        let mut progress = self.scan_progress.write().await;
        progress.running = false;
        progress.finished_at = Some(now_ms());
        progress.error = Some(error.to_string());
    }

    pub async fn scan_progress(&self) -> ImageScanProgress {
        self.scan_progress.read().await.clone()
    }

    pub async fn last_scan(&self) -> Option<ImageScanResult> {
        self.last_scan.read().await.clone()
    }

    async fn save_last_scan(&self, result: &ImageScanResult) -> Result<(), String> {
        let json = serde_json::to_string(result)
            .map_err(|error| format!("序列化图片扫描缓存失败: {error}"))?;
        let path = self.data_dir.join("images-last-scan.json");
        let temp = self.data_dir.join("images-last-scan.json.tmp");
        tokio::fs::write(&temp, json)
            .await
            .map_err(|error| format!("写入图片扫描缓存失败: {error}"))?;
        tokio::fs::rename(&temp, &path)
            .await
            .map_err(|error| format!("替换图片扫描缓存失败: {error}"))
    }

    pub async fn create_jobs(
        &self,
        request: CreateImageJobsRequest,
    ) -> Result<Vec<ImageJobView>, String> {
        let mut seen = HashSet::new();
        let files: Vec<String> = request
            .files
            .into_iter()
            .map(|file| file.trim().to_string())
            .filter(|file| !file.is_empty() && seen.insert(file.clone()))
            .collect();
        if files.is_empty() {
            return Err("请先选择要转换的图片".to_string());
        }

        let quality = request.quality.min(100);
        let output_dir = match request.output_dir.as_deref() {
            Some(directory) if !directory.trim().is_empty() => Some(
                crate::storage::resolve_destination(directory)
                    .map_err(|error| format!("输出目录不可用：{error}"))?
                    .to_string_lossy()
                    .to_string(),
            ),
            _ => None,
        };
        let mut reserved = HashSet::new();
        let mut items = Vec::new();

        for file in files {
            let source = PathBuf::from(&file);
            if !source.is_absolute() {
                return Err(format!("文件路径必须是绝对路径：{file}"));
            }
            if !source.is_file() {
                return Err(format!("文件不存在：{file}"));
            }
            if !has_image_extension(&source) {
                return Err(format!(
                    "不支持的图片格式：{}（WebP 文件会被自动跳过）",
                    source
                        .file_name()
                        .map(|name| name.to_string_lossy().to_string())
                        .unwrap_or_else(|| file.clone())
                ));
            }
            let info = image_metadata(&source)
                .map_err(|error| format!("不是有效的图片 {}: {error}", source.display()))?;
            if info.size_bytes == 0 {
                return Err(format!("文件为空：{}", source.display()));
            }
            let output = output_path_reserving(&source, output_dir.as_deref(), &reserved);
            reserved.insert(output.clone());
            items.push((source, output, info.size_bytes, info.width, info.height));
        }

        let concurrency = request.concurrency.clamp(1, 16) as usize;
        let workers = request
            .cpu_threads
            .map(|threads| threads.clamp(0, 64) as usize)
            .filter(|threads| *threads > 0)
            .map(|threads| concurrency.min(threads))
            .unwrap_or(concurrency);
        let semaphore = Arc::new(Semaphore::new(workers.max(1)));
        let mut views = Vec::new();
        let mut ids = Vec::new();

        for (source, output, source_bytes, width, height) in items {
            let id = uuid::Uuid::new_v4().to_string();
            let view = image_job_view(
                &id,
                &source,
                &output,
                width,
                height,
                source_bytes,
                quality,
                request.lossless,
                request.delete_original,
                now_ms(),
                "queued",
                None,
            );

            {
                let mut jobs = self.inner.jobs.write().await;
                jobs.insert(
                    id.clone(),
                    JobEntry {
                        view: view.clone(),
                        quality,
                        lossless: request.lossless,
                        cancel: CancellationToken::new(),
                    },
                );
            }
            let _ = self
                .inner
                .events
                .send(ImageEvent::ImageJobUpdated { job: view.clone() });
            views.push(view);
            ids.push(id);
        }

        tracing::info!(
            count = views.len(),
            concurrency,
            workers,
            quality,
            lossless = request.lossless,
            delete_original = request.delete_original,
            output_dir = ?output_dir,
            "image conversion jobs queued"
        );

        let batch_ids: HashSet<String> = ids.iter().cloned().collect();
        let batch_started_at = now_ms();
        let summary = format!(
            "WebP · 质量 {} · {} · 并发 {}",
            quality,
            if request.lossless { "无损" } else { "有损" },
            workers
        );
        for id in ids {
            let manager = self.clone();
            let semaphore = semaphore.clone();
            tokio::spawn(async move {
                let Ok(_permit) = semaphore.acquire_owned().await else {
                    return;
                };
                manager.run_job(&id).await;
            });
        }

        if !views.is_empty() {
            let manager = self.clone();
            let history = self.history.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                    let all = manager.list().await;
                    let batch: Vec<ImageJobView> = all
                        .into_iter()
                        .filter(|job| batch_ids.contains(&job.id))
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
                    let finished_at = now_ms();
                    history
                        .add(crate::history::record_from_image_jobs(
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

        self.persist().await;
        Ok(views)
    }

    async fn run_job(&self, id: &str) {
        let (view, quality, lossless, cancel) = {
            let jobs = self.inner.jobs.read().await;
            let Some(entry) = jobs.get(id) else {
                return;
            };
            (
                entry.view.clone(),
                entry.quality,
                entry.lossless,
                entry.cancel.clone(),
            )
        };
        if cancel.is_cancelled() {
            self.mark_canceled(id).await;
            return;
        }
        self.wait_until_resumed(&cancel).await;
        if cancel.is_cancelled() {
            self.mark_canceled(id).await;
            return;
        }

        let source = PathBuf::from(&view.source_path);
        let output = PathBuf::from(&view.output_path);
        let temp = temp_path(&output);
        let _ = tokio::fs::remove_file(&temp).await;
        self.update(id, |entry| {
            entry.view.status = "running".to_string();
            entry.view.started_at = Some(now_ms());
        })
        .await;

        let started = Instant::now();
        tracing::info!(
            id,
            source = %view.source_path,
            output = %view.output_path,
            quality,
            lossless,
            "image conversion started"
        );

        let (progress_tx, mut progress_rx) = mpsc::unbounded_channel::<f64>();
        let progress_manager = self.clone();
        let progress_id = id.to_string();
        let progress_task = tokio::spawn(async move {
            while let Some(progress) = progress_rx.recv().await {
                progress_manager
                    .update(&progress_id, |entry| {
                        entry.view.progress = progress.clamp(0.0, 99.9);
                    })
                    .await;
            }
        });

        let source_for_task = source.clone();
        let temp_for_task = temp.clone();
        let cancel_for_task = cancel.clone();
        let result = tokio::task::spawn_blocking(move || {
            convert_image(
                &source_for_task,
                &temp_for_task,
                quality,
                lossless,
                &cancel_for_task,
                &|progress| {
                    let _ = progress_tx.send(progress);
                },
            )
        })
        .await;
        let _ = progress_task.await;

        if cancel.is_cancelled() {
            let _ = tokio::fs::remove_file(&temp).await;
            tracing::info!(id, "image conversion canceled");
            self.mark_canceled(id).await;
            return;
        }

        let converted = match result {
            Ok(Ok(converted)) => converted,
            Ok(Err(message)) => {
                let _ = tokio::fs::remove_file(&temp).await;
                self.fail_job(id, message).await;
                return;
            }
            Err(error) => {
                let _ = tokio::fs::remove_file(&temp).await;
                self.fail_job(id, format!("图片转换线程异常退出: {error}")).await;
                return;
            }
        };

        if converted.canceled || cancel.is_cancelled() {
            let _ = tokio::fs::remove_file(&temp).await;
            self.mark_canceled(id).await;
            return;
        }

        if let Err(error) = tokio::fs::rename(&temp, &output).await {
            let _ = tokio::fs::remove_file(&temp).await;
            self.fail_job(
                id,
                format!("无法写入输出文件 {}: {error}", output.display()),
            )
            .await;
            return;
        }

        let output_bytes = tokio::fs::metadata(&output)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if output_bytes == 0 {
            let _ = tokio::fs::remove_file(&output).await;
            self.fail_job(id, "WebP 文件写入完成，但输出为空".to_string()).await;
            return;
        }

        let mut note = None;
        if view.delete_original {
            match tokio::fs::remove_file(&source).await {
                Ok(()) => {
                    tracing::info!(id, source = %view.source_path, "image original deleted");
                    note = Some("转换成功，已删除原文件".to_string());
                }
                Err(error) => {
                    tracing::warn!(
                        id,
                        source = %view.source_path,
                        error = %error,
                        "image original deletion failed"
                    );
                    note = Some(format!("转换成功，但删除原文件失败：{error}"));
                }
            }
        }

        let saved_bytes = view.source_bytes.saturating_sub(output_bytes);
        tracing::info!(
            id,
            source_bytes = view.source_bytes,
            output_bytes,
            saved_bytes = saved_bytes as i64,
            frames = converted.frames,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "image conversion completed"
        );

        self.update(id, |entry| {
            entry.view.status = "done".to_string();
            entry.view.progress = 100.0;
            entry.view.output_bytes = output_bytes;
            entry.view.frames = converted.frames;
            entry.view.finished_at = Some(now_ms());
            entry.view.note = note;
            entry.view.error = None;
        })
        .await;
    }

    async fn mark_canceled(&self, id: &str) {
        self.update(id, |entry| {
            if entry.view.status == "done" || entry.view.status == "failed" {
                return;
            }
            entry.view.status = "canceled".to_string();
            entry.view.finished_at = Some(now_ms());
        })
        .await;
    }

    async fn fail_job(&self, id: &str, message: String) {
        tracing::warn!(id, error = %message, "image conversion failed");
        self.update(id, |entry| {
            entry.view.status = "failed".to_string();
            entry.view.error = Some(message);
            entry.view.finished_at = Some(now_ms());
        })
        .await;
    }

    async fn update<F>(&self, id: &str, update: F)
    where
        F: FnOnce(&mut JobEntry),
    {
        let (snapshot, status_changed) = {
            let mut jobs = self.inner.jobs.write().await;
            let Some(entry) = jobs.get_mut(id) else {
                return;
            };
            let before = entry.view.status.clone();
            update(entry);
            (entry.view.clone(), before != entry.view.status)
        };
        if status_changed {
            self.persist().await;
        }
        let _ = self
            .inner
            .events
            .send(ImageEvent::ImageJobUpdated { job: snapshot });
    }

    async fn persist(&self) {
        let Some(path) = self.inner.persist_path.as_ref() else {
            return;
        };
        let records: Vec<PersistedImageJob> = {
            let jobs = self.inner.jobs.read().await;
            jobs.iter()
                .filter(|(_, entry)| {
                    entry.view.status == "queued" || entry.view.status == "running"
                })
                .map(|(id, entry)| PersistedImageJob {
                    id: id.clone(),
                    source_path: entry.view.source_path.clone(),
                    output_path: entry.view.output_path.clone(),
                    width: entry.view.width,
                    height: entry.view.height,
                    source_bytes: entry.view.source_bytes,
                    quality: entry.quality,
                    lossless: entry.lossless,
                    delete_original: entry.view.delete_original,
                    created_at: entry.view.created_at,
                })
                .collect()
        };
        let json = match serde_json::to_string_pretty(&records) {
            Ok(json) => json,
            Err(error) => {
                tracing::warn!(%error, "序列化图片断点失败");
                return;
            }
        };
        let temp = path.with_file_name(format!(
            ".{}.{}.tmp",
            path.file_name().map(|name| name.to_string_lossy()).unwrap_or_default(),
            uuid::Uuid::new_v4().simple()
        ));
        if let Err(error) = tokio::fs::write(&temp, json).await {
            tracing::warn!(%error, path = %temp.display(), "写入图片断点失败");
            return;
        }
        if let Err(error) = tokio::fs::rename(&temp, path).await {
            tracing::warn!(%error, path = %path.display(), "替换图片断点失败");
        }
    }

    /// Restore queued/running image jobs after a service restart. Each image is
    /// atomic: an interrupted image is redone, completed images are skipped.
    pub async fn restore_jobs(&self) -> usize {
        let Some(path) = self.inner.persist_path.as_ref() else {
            return 0;
        };
        let Ok(raw) = tokio::fs::read_to_string(path).await else {
            return 0;
        };
        let records: Vec<PersistedImageJob> = match serde_json::from_str(&raw) {
            Ok(records) => records,
            Err(error) => {
                tracing::warn!(%error, path = %path.display(), "忽略无法解析的图片断点");
                return 0;
            }
        };
        let mut restored_ids = Vec::new();
        for record in records {
            let source = PathBuf::from(&record.source_path);
            let output = PathBuf::from(&record.output_path);
            if !source.is_file() || output.exists() {
                continue;
            }
            let view = image_job_view(
                &record.id,
                &source,
                &output,
                record.width,
                record.height,
                record.source_bytes,
                record.quality,
                record.lossless,
                record.delete_original,
                record.created_at,
                "queued",
                Some("服务重启后自动恢复".to_string()),
            );
            let id = record.id;
            let quality = record.quality;
            let lossless = record.lossless;
            {
                let mut jobs = self.inner.jobs.write().await;
                jobs.insert(
                    id.clone(),
                    JobEntry {
                        view: view.clone(),
                        quality,
                        lossless,
                        cancel: CancellationToken::new(),
                    },
                );
            }
            let _ = self
                .inner
                .events
                .send(ImageEvent::ImageJobUpdated { job: view });
            restored_ids.push(id);
        }

        if !restored_ids.is_empty() {
            let semaphore = Arc::new(Semaphore::new(1));
            for id in &restored_ids {
                let manager = self.clone();
                let semaphore = semaphore.clone();
                let id = id.clone();
                tokio::spawn(async move {
                    let Ok(_permit) = semaphore.acquire_owned().await else {
                        return;
                    };
                    manager.run_job(&id).await;
                });
            }
            tracing::info!(count = restored_ids.len(), "restored image jobs after restart");
        }
        self.persist().await;
        restored_ids.len()
    }

    pub async fn list(&self) -> Vec<ImageJobView> {
        let jobs = self.inner.jobs.read().await;
        let mut views: Vec<ImageJobView> = jobs.values().map(|entry| entry.view.clone()).collect();
        views.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        views
    }

    pub fn is_paused(&self) -> bool {
        *self.inner.paused.borrow()
    }

    pub async fn queue_state(&self) -> (bool, usize, usize) {
        let jobs = self.inner.jobs.read().await;
        let running = jobs
            .values()
            .filter(|entry| entry.view.status == "running")
            .count();
        let queued = jobs
            .values()
            .filter(|entry| entry.view.status == "queued")
            .count();
        (self.is_paused(), running, queued)
    }

    async fn active_count(&self) -> usize {
        let jobs = self.inner.jobs.read().await;
        jobs.values()
            .filter(|entry| {
                entry.view.status == "queued" || entry.view.status == "running"
            })
            .count()
    }

    async fn wait_until_resumed(&self, cancel: &CancellationToken) {
        loop {
            if !self.is_paused() {
                return;
            }
            let mut receiver = self.inner.paused.subscribe();
            if !*receiver.borrow() {
                return;
            }
            tokio::select! {
                _ = cancel.cancelled() => return,
                changed = receiver.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
            }
        }
    }

    /// Pause queued image jobs. A file already being encoded finishes first.
    pub async fn pause_all(&self) -> usize {
        let _ = self.inner.paused.send_replace(true);
        let active = self.active_count().await;
        tracing::info!(active, "image conversion paused");
        active
    }

    pub async fn resume_all(&self) -> usize {
        let _ = self.inner.paused.send_replace(false);
        let active = self.active_count().await;
        tracing::info!(active, "image conversion resumed");
        active
    }

    pub async fn cancel_all(&self) -> usize {
        let _ = self.inner.paused.send_replace(false);
        let ids: Vec<String> = {
            let jobs = self.inner.jobs.read().await;
            jobs.iter()
                .filter(|(_, entry)| {
                    entry.view.status == "queued" || entry.view.status == "running"
                })
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in &ids {
            let _ = self.cancel(id).await;
        }
        tracing::info!(count = ids.len(), "image conversion all canceled");
        ids.len()
    }

    pub async fn cancel(&self, id: &str) -> Result<(), String> {
        let (cancel, active) = {
            let jobs = self.inner.jobs.read().await;
            let entry = jobs.get(id).ok_or_else(|| "任务不存在".to_string())?;
            (
                entry.cancel.clone(),
                matches!(entry.view.status.as_str(), "queued" | "running"),
            )
        };
        if !active {
            return Err("任务已经结束".to_string());
        }
        tracing::info!(id, "image conversion cancel requested");
        cancel.cancel();
        let state = {
            let jobs = self.inner.jobs.read().await;
            jobs.get(id).map(|entry| entry.view.status.clone())
        };
        if state.as_deref() == Some("queued") {
            self.mark_canceled(id).await;
        }
        Ok(())
    }

    pub async fn retry(&self, id: &str) -> Result<Vec<ImageJobView>, String> {
        let view = {
            let jobs = self.inner.jobs.read().await;
            let entry = jobs.get(id).ok_or_else(|| "任务不存在".to_string())?;
            if matches!(entry.view.status.as_str(), "queued" | "running") {
                return Err("任务仍在进行中".to_string());
            }
            entry.view.clone()
        };
        let quality = view.quality;
        let lossless = view.lossless;
        let output_dir = Path::new(&view.output_path)
            .parent()
            .map(|path| path.to_string_lossy().to_string());
        tracing::info!(id, "image conversion retry requested");
        self.create_jobs(CreateImageJobsRequest {
            files: vec![view.source_path],
            quality,
            lossless,
            concurrency: 1,
            cpu_threads: None,
            delete_original: view.delete_original,
            output_dir,
        })
        .await
    }

    pub async fn clear_finished(&self) -> usize {
        let mut jobs = self.inner.jobs.write().await;
        let before = jobs.len();
        jobs.retain(|_, entry| matches!(entry.view.status.as_str(), "queued" | "running"));
        let removed = before - jobs.len();
        drop(jobs);
        tracing::info!(removed, "image finished jobs cleared");
        if removed > 0 {
            let _ = self.inner.events.send(ImageEvent::ImageJobsCleared);
        }
        removed
    }
}

fn default_true() -> bool {
    true
}

fn default_quality() -> u8 {
    DEFAULT_QUALITY
}

fn default_concurrency() -> u32 {
    2
}

fn has_image_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            let extension = extension.to_ascii_lowercase();
            extension != "webp" && IMAGE_EXTENSIONS.contains(&extension.as_str())
        })
        .unwrap_or(false)
}

fn format_label(path: &Path) -> String {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" | "jpe" | "jfif" => "JPEG".to_string(),
        "tif" | "tiff" => "TIFF".to_string(),
        "png" | "apng" => "PNG".to_string(),
        "gif" => "GIF".to_string(),
        "bmp" => "BMP".to_string(),
        "ico" => "ICO".to_string(),
        "tga" => "TGA".to_string(),
        "pnm" | "ppm" | "pgm" | "pbm" => "PNM".to_string(),
        "qoi" => "QOI".to_string(),
        "hdr" => "HDR".to_string(),
        "exr" => "EXR".to_string(),
        "dds" => "DDS".to_string(),
        "ff" => "Farbfeld".to_string(),
        other => other.to_ascii_uppercase(),
    }
}

fn image_metadata(path: &Path) -> Result<ImageFile, String> {
    let reader = image::ImageReader::open(path)
        .map_err(|error| format!("无法打开图片: {error}"))?
        .with_guessed_format()
        .map_err(|error| format!("无法识别图片格式: {error}"))?;
    let format = reader
        .format()
        .map(|format| format.extensions_str().first().copied().unwrap_or(""))
        .unwrap_or("");
    let (width, height) = reader
        .into_dimensions()
        .map_err(|error| format!("无法读取图片尺寸: {error}"))?;
    let metadata = std::fs::metadata(path).map_err(|error| format!("无法读取文件: {error}"))?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    Ok(ImageFile {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string()),
        size_bytes: metadata.len(),
        modified_at,
        format: if format.is_empty() {
            format_label(path)
        } else {
            format_label(&PathBuf::from(format!("x.{format}")))
        },
        width,
        height,
    })
}

fn output_path_reserving(
    source: &Path,
    output_dir: Option<&str>,
    reserved: &HashSet<PathBuf>,
) -> PathBuf {
    let directory = output_dir
        .map(PathBuf::from)
        .or_else(|| source.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let stem = source
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "image".to_string());
    let mut candidate = directory.join(format!("{stem}.webp"));
    let mut index = 2;
    while candidate.exists() || reserved.contains(&candidate) {
        candidate = directory.join(format!("{stem}-{index}.webp"));
        index += 1;
    }
    candidate
}

fn temp_path(output: &Path) -> PathBuf {
    let name = output
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "image.webp".to_string());
    output.with_file_name(format!(
        ".{name}.{}.part",
        uuid::Uuid::new_v4().simple()
    ))
}

struct ConvertedImage {
    frames: u32,
    canceled: bool,
}

enum Decoded {
    Static(DynamicImage),
    Animation(Vec<image::Frame>),
}

fn convert_image(
    source: &Path,
    temp: &Path,
    quality: u8,
    lossless: bool,
    cancel: &CancellationToken,
    progress: &dyn Fn(f64),
) -> Result<ConvertedImage, String> {
    let data = std::fs::read(source)
        .map_err(|error| format!("无法读取 {}: {error}", source.display()))?;
    if data.is_empty() {
        return Err("图片文件为空".to_string());
    }
    let decoded = decode_image(source, &data)?;
    if cancel.is_cancelled() {
        return Ok(ConvertedImage {
            frames: 0,
            canceled: true,
        });
    }
    progress(10.0);

    let (bytes, frames) = match decoded {
        Decoded::Static(image) => {
            progress(25.0);
            let bytes = encode_static(&image, quality, lossless)?;
            (bytes, 1)
        }
        Decoded::Animation(mut frames) => {
            if frames.is_empty() {
                return Err("没有可转换的图片帧".to_string());
            }
            if frames.len() == 1 {
                let frame = frames.remove(0);
                let buffer = frame.into_buffer();
                let image = DynamicImage::ImageRgba8(buffer);
                let bytes = encode_static(&image, quality, lossless)?;
                (bytes, 1)
            } else {
                let frame_count = frames.len() as u32;
                let bytes = encode_animation(frames, quality, lossless, cancel, progress)?;
                (bytes, frame_count)
            }
        }
    };

    if cancel.is_cancelled() {
        return Ok(ConvertedImage {
            frames: 0,
            canceled: true,
        });
    }
    progress(95.0);
    if let Some(parent) = temp.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建输出目录 {}: {error}", parent.display()))?;
    }
    std::fs::write(temp, &bytes).map_err(|error| format!("无法写入临时文件: {error}"))?;
    Ok(ConvertedImage {
        frames,
        canceled: false,
    })
}

fn decode_image(source: &Path, data: &[u8]) -> Result<Decoded, String> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension == "gif" {
        let decoder = image::codecs::gif::GifDecoder::new(Cursor::new(data))
            .map_err(|error| format!("GIF 解码失败: {error}"))?;
        let frames = decoder
            .into_frames()
            .collect_frames()
            .map_err(|error| format!("GIF 帧解码失败: {error}"))?;
        if frames.is_empty() {
            return Err("GIF 中没有图片帧".to_string());
        }
        if frames.len() > 1 {
            return Ok(Decoded::Animation(frames));
        }
        let frame = frames.into_iter().next().unwrap();
        return Ok(Decoded::Static(DynamicImage::ImageRgba8(
            frame.into_buffer(),
        )));
    }
    if extension == "png" || extension == "apng" {
        let decoder = image::codecs::png::PngDecoder::new(Cursor::new(data))
            .map_err(|error| format!("PNG 解码失败: {error}"))?;
        if decoder.is_apng().unwrap_or(false) {
            let frames = decoder
                .apng()
                .map_err(|error| format!("APNG 解码失败: {error}"))?
                .into_frames()
                .collect_frames()
                .map_err(|error| format!("APNG 帧解码失败: {error}"))?;
            if frames.len() > 1 {
                return Ok(Decoded::Animation(frames));
            }
        }
    }
    let image = image::load_from_memory(&data)
        .map_err(|error| format!("图片解码失败: {error}"))?;
    Ok(Decoded::Static(image))
}

fn encode_static(
    image: &DynamicImage,
    quality: u8,
    lossless: bool,
) -> Result<Vec<u8>, String> {
    let has_alpha = image.color().has_alpha();
    let width = image.width();
    let height = image.height();
    if width == 0 || height == 0 {
        return Err("图片尺寸无效".to_string());
    }
    if lossless {
        let config = LosslessConfig::new()
            .with_quality(f32::from(quality))
            .with_method(4);
        if has_alpha {
            let pixels = image.to_rgba8();
            EncodeRequest::lossless(
                &config,
                pixels.as_raw(),
                PixelLayout::Rgba8,
                width,
                height,
            )
            .encode()
            .map_err(|error| format!("WebP 编码失败: {error}"))
        } else {
            let pixels = image.to_rgb8();
            EncodeRequest::lossless(&config, pixels.as_raw(), PixelLayout::Rgb8, width, height)
                .encode()
                .map_err(|error| format!("WebP 编码失败: {error}"))
        }
    } else {
        let config = LossyConfig::new()
            .with_quality(f32::from(quality))
            .with_method(4);
        if has_alpha {
            let pixels = image.to_rgba8();
            EncodeRequest::lossy(
                &config,
                pixels.as_raw(),
                PixelLayout::Rgba8,
                width,
                height,
            )
            .encode()
            .map_err(|error| format!("WebP 编码失败: {error}"))
        } else {
            let pixels = image.to_rgb8();
            EncodeRequest::lossy(&config, pixels.as_raw(), PixelLayout::Rgb8, width, height)
                .encode()
                .map_err(|error| format!("WebP 编码失败: {error}"))
        }
    }
}

fn encode_animation(
    frames: Vec<image::Frame>,
    quality: u8,
    lossless: bool,
    cancel: &CancellationToken,
    progress: &dyn Fn(f64),
) -> Result<Vec<u8>, String> {
    let width = frames[0].buffer().width();
    let height = frames[0].buffer().height();
    if width == 0 || height == 0 {
        return Err("动画尺寸无效".to_string());
    }
    let config = if lossless {
        EncoderConfig::Lossless(
            LosslessConfig::new()
                .with_quality(f32::from(quality))
                .with_method(4),
        )
    } else {
        EncoderConfig::Lossy(
            LossyConfig::new()
                .with_quality(f32::from(quality))
                .with_method(4),
        )
    };
    let mut encoder = AnimationEncoder::new(width, height, AnimationConfig::default())
        .map_err(|error| format!("无法创建动画编码器: {error}"))?;
    let total = frames.len() as f64;
    let mut timestamp = 0u32;
    let mut last_duration = 100u32;
    for (index, frame) in frames.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err("已取消".to_string());
        }
        let buffer = frame.buffer();
        if buffer.width() != width || buffer.height() != height {
            return Err("动画帧尺寸不一致，暂不支持该文件".to_string());
        }
        let (numerator, denominator) = frame.delay().numer_denom_ms();
        let duration = if denominator == 0 {
            100
        } else {
            (u64::from(numerator) * 1000 / u64::from(denominator)).max(10) as u32
        };
        encoder
            .add_frame(buffer.as_raw(), PixelLayout::Rgba8, timestamp, &config)
            .map_err(|error| format!("动画帧编码失败: {error}"))?;
        timestamp = timestamp.saturating_add(duration);
        last_duration = duration;
        progress(15.0 + (index as f64 + 1.0) / total * 75.0);
    }
    encoder
        .finalize(last_duration)
        .map_err(|error| format!("动画 WebP 封装失败: {error}"))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[allow(clippy::too_many_arguments)]
fn image_job_view(
    id: &str,
    source: &Path,
    output: &Path,
    width: u32,
    height: u32,
    source_bytes: u64,
    quality: u8,
    lossless: bool,
    delete_original: bool,
    created_at: i64,
    status: &str,
    note: Option<String>,
) -> ImageJobView {
    ImageJobView {
        id: id.to_string(),
        source_path: source.to_string_lossy().to_string(),
        source_name: source
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| source.to_string_lossy().to_string()),
        output_path: output.to_string_lossy().to_string(),
        source_format: format_label(source),
        width,
        height,
        source_bytes,
        output_bytes: 0,
        quality,
        lossless,
        delete_original,
        status: status.to_string(),
        progress: 0.0,
        frames: 1,
        error: None,
        note,
        created_at,
        started_at: None,
        finished_at: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_webp_sources() {
        assert!(!has_image_extension(Path::new("photo.webp")));
        assert!(!has_image_extension(Path::new("photo.WEBP")));
        assert!(has_image_extension(Path::new("photo.JPG")));
        assert!(has_image_extension(Path::new("animation.gif")));
    }

    #[test]
    fn output_keeps_stem_and_avoids_existing_files() {
        let directory = std::env::temp_dir().join(format!(
            "wcdc-image-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let source = directory.join("holiday.jpg");
        std::fs::write(&source, b"x").unwrap();
        let first = output_path_reserving(&source, None, &HashSet::new());
        assert_eq!(first, directory.join("holiday.webp"));

        std::fs::write(&first, b"existing").unwrap();
        let second = output_path_reserving(&source, None, &HashSet::new());
        assert_eq!(second, directory.join("holiday-2.webp"));
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn converts_png_to_webp_with_requested_quality() {
        let directory = std::env::temp_dir().join(format!(
            "wcdc-image-convert-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let source = directory.join("pixel.png");
        let image = image::RgbaImage::from_pixel(8, 8, image::Rgba([12, 34, 56, 200]));
        image.save(&source).unwrap();
        let output = directory.join("pixel.webp");
        let converted = convert_image(
            &source,
            &output,
            70,
            false,
            &CancellationToken::new(),
            &|_| {},
        )
        .unwrap();
        assert_eq!(converted.frames, 1);
        let bytes = std::fs::read(&output).unwrap();
        assert!(bytes.starts_with(b"RIFF"));
        assert_eq!(&bytes[8..12], b"WEBP");
        let _ = std::fs::remove_dir_all(&directory);
    }
}
