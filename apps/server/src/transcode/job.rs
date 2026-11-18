use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{broadcast, RwLock, Semaphore};
use tokio_util::sync::CancellationToken;

use super::command::{self, AudioMode, ResolvedOptions};
use super::exec;
use super::media::MediaFile;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub id: String,
    pub source_path: String,
    pub source_name: String,
    pub output_path: String,
    pub source_codec: String,
    pub source_width: u32,
    pub source_height: u32,
    pub source_bytes: u64,
    pub source_bitrate_kbps: u64,
    pub target_codec: String,
    pub container: String,
    pub resolution: String,
    pub encoder: String,
    pub hardware: bool,
    pub accel: Option<String>,
    pub vendor: Option<String>,
    pub bitrate_kbps: u64,
    pub quality: Option<String>,
    pub audio: String,
    pub delete_original: bool,
    pub status: String,
    pub progress: f64,
    pub duration_ms: i64,
    pub out_time_ms: i64,
    pub speed: Option<f64>,
    pub fps: Option<f64>,
    pub eta_seconds: Option<f64>,
    pub output_bytes: u64,
    pub current_bitrate_kbps: Option<u64>,
    pub estimated_bytes: u64,
    pub error: Option<String>,
    pub note: Option<String>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TranscodeEvent {
    JobUpdated { job: JobView },
    JobsCleared,
}

struct JobEntry {
    view: JobView,
    media: MediaFile,
    options: ResolvedOptions,
    cancel: CancellationToken,
    ffmpeg: PathBuf,
}

struct Inner {
    jobs: RwLock<HashMap<String, JobEntry>>,
    events: broadcast::Sender<TranscodeEvent>,
}

#[derive(Clone)]
pub struct JobManager {
    inner: Arc<Inner>,
}

impl JobManager {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(512);
        Self {
            inner: Arc::new(Inner {
                jobs: RwLock::new(HashMap::new()),
                events,
            }),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TranscodeEvent> {
        self.inner.events.subscribe()
    }

    pub async fn list(&self) -> Vec<JobView> {
        let jobs = self.inner.jobs.read().await;
        let mut views: Vec<JobView> = jobs.values().map(|entry| entry.view.clone()).collect();
        views.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        views
    }

    pub async fn create_jobs(
        &self,
        ffmpeg: PathBuf,
        items: Vec<(MediaFile, ResolvedOptions, PathBuf)>,
        concurrency: u32,
    ) -> Result<Vec<JobView>, String> {
        if items.is_empty() {
            return Err("没有可转码的文件".to_string());
        }
        let concurrency = concurrency.clamp(1, 4) as usize;
        let semaphore = Arc::new(Semaphore::new(concurrency));
        let mut views = Vec::new();
        let mut ids = Vec::new();

        for (media, options, output) in items {
            let id = uuid::Uuid::new_v4().to_string();
            let estimated_bytes = command::estimated_bytes(&options, &media);
            let view = JobView {
                id: id.clone(),
                source_path: media.path.clone(),
                source_name: media.name.clone(),
                output_path: output.to_string_lossy().to_string(),
                source_codec: media.video_codec.clone(),
                source_width: media.width,
                source_height: media.height,
                source_bytes: media.size_bytes,
                source_bitrate_kbps: media.video_bitrate_bps / 1000,
                target_codec: options.target_codec.clone(),
                container: options.container.clone(),
                resolution: options.resolution_label.clone(),
                encoder: options.encoder.clone(),
                hardware: options.hardware,
                accel: options.accel.clone(),
                vendor: options.vendor.clone(),
                bitrate_kbps: options.bitrate_kbps,
                quality: options.crf.map(|value| format!("CRF {value}")),
                audio: match options.audio {
                    AudioMode::Copy => "copy".to_string(),
                    AudioMode::Aac => "aac".to_string(),
                    AudioMode::None => "none".to_string(),
                },
                delete_original: options.delete_original,
                status: "queued".to_string(),
                progress: 0.0,
                duration_ms: media.duration_ms,
                out_time_ms: 0,
                speed: None,
                fps: None,
                eta_seconds: None,
                output_bytes: 0,
                current_bitrate_kbps: None,
                estimated_bytes,
                error: None,
                note: None,
                created_at: now_ms(),
                started_at: None,
                finished_at: None,
            };

            {
                let mut jobs = self.inner.jobs.write().await;
                jobs.insert(
                    id.clone(),
                    JobEntry {
                        view: view.clone(),
                        media,
                        options,
                        cancel: CancellationToken::new(),
                        ffmpeg: ffmpeg.clone(),
                    },
                );
            }
            let _ = self
                .inner
                .events
                .send(TranscodeEvent::JobUpdated { job: view.clone() });
            views.push(view);
            ids.push(id);
        }

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

        Ok(views)
    }

    async fn run_job(&self, id: &str) {
        let (media, mut options, cancel, ffmpeg, output) = {
            let jobs = self.inner.jobs.read().await;
            let Some(entry) = jobs.get(id) else {
                return;
            };
            (
                entry.media.clone(),
                entry.options.clone(),
                entry.cancel.clone(),
                entry.ffmpeg.clone(),
                PathBuf::from(entry.view.output_path.clone()),
            )
        };

        if cancel.is_cancelled() {
            self.mark_canceled(id).await;
            return;
        }

        let temp = command::temp_path(&output);
        let (_, free_bytes) = crate::storage::capacity(output.parent().unwrap_or(Path::new(".")));
        let estimated = {
            let jobs = self.inner.jobs.read().await;
            jobs.get(id)
                .map(|entry| entry.view.estimated_bytes)
                .unwrap_or(0)
        };
        if free_bytes > 0 && free_bytes < estimated.saturating_add(100 * 1024 * 1024) {
            self.fail_job(
                id,
                format!(
                    "输出目录可用空间不足：需要约 {}，当前可用 {}",
                    human_bytes(estimated),
                    human_bytes(free_bytes)
                ),
            )
            .await;
            return;
        }

        let _ = tokio::fs::remove_file(&temp).await;
        self.update(id, |entry| {
            entry.view.status = "running".to_string();
            entry.view.started_at = Some(now_ms());
        })
        .await;
        let started = std::time::Instant::now();
        tracing::info!(
            id,
            source = %media.path,
            output = %output.display(),
            encoder = %options.encoder,
            hardware = options.hardware,
            crf = ?options.crf,
            bitrate_kbps = options.bitrate_kbps,
            "transcode job started"
        );

        let mut attempt = 0;
        let output_bytes = loop {
            let args = command::build_args(&media, &options, &temp);            tracing::debug!(
                id,
                command = %args
                    .iter()
                    .map(|arg| arg.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join(" "),
                "transcode ffmpeg command"
            );
            let mut process = Command::new(&ffmpeg);
            process
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            exec::hide_console(&mut process);

            let mut child = match process.spawn() {
                Ok(child) => child,
                Err(error) => {
                    self.fail_job(id, format!("无法启动 ffmpeg: {error}")).await;
                    return;
                }
            };

            let Some(stdout) = child.stdout.take() else {
                self.fail_job(id, "无法读取 ffmpeg 输出".to_string()).await;
                return;
            };
            let stderr = child.stderr.take();
            let stderr_task = tokio::spawn(async move {
                let Some(stderr) = stderr else {
                    return String::new();
                };
                let mut reader = BufReader::new(stderr).lines();
                let mut text = String::new();
                while let Ok(Some(line)) = reader.next_line().await {
                    if text.len() < 16 * 1024 {
                        text.push_str(&line);
                        text.push('\n');
                    }
                }
                text
            });

            let mut reader = BufReader::new(stdout).lines();
            let mut progress = ProgressState::default();
            let mut canceled = false;
            let mut next_milestone = 25.0;

            loop {
                tokio::select! {
                    _ = cancel.cancelled() => {
                        canceled = true;
                        let _ = child.kill().await;
                        break;
                    }
                    line = reader.next_line() => {
                        match line {
                            Ok(Some(line)) => {
                                if progress.apply(&line) {
                                    let snapshot = progress.snapshot();
                                    self.update(id, |entry| {
                                        snapshot.apply(&mut entry.view);
                                    })
                                    .await;
                                    let out_ms = progress.out_time_us / 1000;
                                    let percent = if media.duration_ms > 0 {
                                        out_ms as f64 / media.duration_ms as f64 * 100.0
                                    } else {
                                        0.0
                                    };
                                    if percent >= next_milestone && next_milestone <= 75.0 {
                                        tracing::info!(
                                            id,
                                            percent = next_milestone,
                                            speed = ?progress.speed,
                                            "transcode progress"
                                        );
                                        next_milestone += 25.0;
                                    }
                                }
                            }
                            Ok(None) => break,
                            Err(_) => break,
                        }
                    }
                }
            }

            let status = child.wait().await;
            let stderr_text = stderr_task.await.unwrap_or_default();

            if canceled || cancel.is_cancelled() {
                let _ = tokio::fs::remove_file(&temp).await;
                tracing::info!(id, "transcode job canceled");
                self.mark_canceled(id).await;
                return;
            }

            let exit_ok = status.map(|status| status.success()).unwrap_or(false);
            if !exit_ok {
                let partial_bytes = tokio::fs::metadata(&temp)
                    .await
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                let _ = tokio::fs::remove_file(&temp).await;
                let message = exec::error_line(&stderr_text)
                    .unwrap_or_else(|| "ffmpeg 转码失败，未返回错误信息".to_string());

                // FFmpeg can advertise an encoder that the installed driver /
                // GPU cannot actually open (classic example: av1_qsv on an
                // older Intel iGPU). Fail over to the software encoder once
                // instead of leaving the whole batch failed.
                if attempt == 0
                    && options.hardware
                    && partial_bytes == 0
                    && encoder_open_failure(&stderr_text)
                {
                    if let Some(fallback) = options.software_fallback.clone() {
                        let hardware_encoder = options.encoder.clone();
                        tracing::warn!(
                            id,
                            hardware_encoder = %hardware_encoder,
                            software_encoder = %fallback,
                            error = %message,
                            "hardware encoder failed to open; retrying with software encoder"
                        );
                        options = options.switch_to_software(fallback.clone());
                        let next_options = options.clone();
                        self.update(id, |entry| {
                            entry.options = next_options;
                            entry.view.encoder = fallback.clone();
                            entry.view.hardware = false;
                            entry.view.accel = None;
                            entry.view.vendor = None;
                            entry.view.quality = entry
                                .options
                                .crf
                                .map(|value| format!("CRF {value}"));
                            entry.view.progress = 0.0;
                            entry.view.out_time_ms = 0;
                            entry.view.speed = None;
                            entry.view.fps = None;
                            entry.view.eta_seconds = None;
                            entry.view.current_bitrate_kbps = None;
                            entry.view.note = Some(format!(
                                "硬件编码器 {hardware_encoder} 无法启动，已自动改用 {fallback}"
                            ));
                        })
                        .await;
                        attempt += 1;
                        continue;
                    }
                }

                self.fail_job(id, message).await;
                return;
            }

            match tokio::fs::metadata(&temp).await {
                Ok(metadata) if metadata.len() > 0 => break metadata.len(),
                _ => {
                    let _ = tokio::fs::remove_file(&temp).await;
                    self.fail_job(id, "ffmpeg 已退出，但没有生成有效的输出文件".to_string())
                        .await;
                    return;
                }
            }
        };

        let replaces_source = same_path(Path::new(&media.path), &output);
        let mut note = None;

        if replaces_source {
            let backup = replacement_backup_path(&output);
            if let Err(error) = tokio::fs::rename(&output, &backup).await {
                let _ = tokio::fs::remove_file(&temp).await;
                self.fail_job(
                    id,
                    format!("无法替换原文件 {}: {error}", output.display()),
                )
                .await;
                return;
            }
            if let Err(error) = tokio::fs::rename(&temp, &output).await {
                if let Err(restore_error) = tokio::fs::rename(&backup, &output).await {
                    tracing::error!(
                        id,
                        backup = %backup.display(),
                        error = %restore_error,
                        "transcode replacement rollback failed"
                    );
                }
                let _ = tokio::fs::remove_file(&temp).await;
                self.fail_job(
                    id,
                    format!("无法写入替换文件 {}: {error}", output.display()),
                )
                .await;
                return;
            }
            match tokio::fs::remove_file(&backup).await {
                Ok(()) => tracing::info!(
                    id,
                    output = %output.display(),
                    "transcode original replaced"
                ),
                Err(error) => tracing::warn!(
                    id,
                    backup = %backup.display(),
                    error = %error,
                    "transcode replacement backup cleanup failed"
                ),
            }
            note = Some("转码成功，已替换原文件".to_string());
        } else {
            if let Err(error) = tokio::fs::rename(&temp, &output).await {
                let _ = tokio::fs::remove_file(&temp).await;
                self.fail_job(
                    id,
                    format!("无法写入输出文件 {}: {error}", output.display()),
                )
                .await;
                return;
            }

            if options.delete_original {
                match tokio::fs::remove_file(&media.path).await {
                    Ok(()) => {
                        tracing::info!(id, source = %media.path, "transcode original deleted");
                        note = Some("转码成功，已删除原文件".to_string());
                    }
                    Err(error) => {
                        tracing::warn!(
                            id,
                            source = %media.path,
                            error = %error,
                            "transcode original deletion failed"
                        );
                        note = Some(format!("转码成功，但删除原文件失败：{error}"));
                    }
                }
            }
        }

        let delta_percent = if media.size_bytes > 0 {
            Some(
                (output_bytes as f64 - media.size_bytes as f64) / media.size_bytes as f64
                    * 100.0,
            )
        } else {
            None
        };
        tracing::info!(
            id,
            source_bytes = media.size_bytes,
            output_bytes,
            delta_percent = ?delta_percent,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "transcode job completed"
        );

        self.update(id, |entry| {
            entry.view.status = "done".to_string();
            entry.view.progress = 100.0;
            entry.view.out_time_ms = entry.view.duration_ms;
            entry.view.speed = None;
            entry.view.fps = None;
            entry.view.eta_seconds = None;
            entry.view.current_bitrate_kbps = None;
            entry.view.output_bytes = output_bytes;
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
            entry.view.speed = None;
            entry.view.fps = None;
            entry.view.eta_seconds = None;
            entry.view.current_bitrate_kbps = None;
        })
        .await;
    }

    async fn fail_job(&self, id: &str, message: String) {
        tracing::warn!(id, error = %message, "transcode job failed");
        self.update(id, |entry| {
            entry.view.status = "failed".to_string();
            entry.view.error = Some(message);
            entry.view.finished_at = Some(now_ms());
            entry.view.speed = None;
            entry.view.fps = None;
            entry.view.eta_seconds = None;
            entry.view.current_bitrate_kbps = None;
        })
        .await;
    }

    async fn update<F>(&self, id: &str, update: F)
    where
        F: FnOnce(&mut JobEntry),
    {
        let snapshot = {
            let mut jobs = self.inner.jobs.write().await;
            let Some(entry) = jobs.get_mut(id) else {
                return;
            };
            update(entry);
            entry.view.clone()
        };
        let _ = self
            .inner
            .events
            .send(TranscodeEvent::JobUpdated { job: snapshot });
    }

    pub async fn cancel(&self, id: &str) -> Result<(), String> {
        let (cancel, queued) = {
            let jobs = self.inner.jobs.read().await;
            let entry = jobs.get(id).ok_or_else(|| "任务不存在".to_string())?;
            (
                entry.cancel.clone(),
                entry.view.status == "queued" || entry.view.status == "running",
            )
        };
        if !queued {
            return Err("任务已经结束".to_string());
        }
        tracing::info!(id, "transcode cancel requested");
        cancel.cancel();
        let snapshot = {
            let jobs = self.inner.jobs.read().await;
            jobs.get(id).map(|entry| entry.view.status.clone())
        };
        if snapshot.as_deref() == Some("queued") {
            self.mark_canceled(id).await;
        }
        Ok(())
    }

    pub async fn retry(&self, id: &str) -> Result<Vec<JobView>, String> {
        let (ffmpeg, media, mut options) = {
            let jobs = self.inner.jobs.read().await;
            let entry = jobs.get(id).ok_or_else(|| "任务不存在".to_string())?;
            if matches!(entry.view.status.as_str(), "queued" | "running") {
                return Err("任务仍在进行中".to_string());
            }
            (
                entry.ffmpeg.clone(),
                entry.media.clone(),
                entry.options.clone(),
            )
        };
        tracing::info!(id, "transcode retry requested");
        options.concurrency = 1;
        let output = command::output_path(Path::new(&media.path), &options)?;
        self.create_jobs(ffmpeg, vec![(media, options, output)], 1)
            .await
    }

    pub async fn clear_finished(&self) -> usize {
        let mut jobs = self.inner.jobs.write().await;
        let before = jobs.len();
        jobs.retain(|_, entry| {
            matches!(entry.view.status.as_str(), "queued" | "running")
        });
        let removed = before - jobs.len();
        drop(jobs);
        tracing::info!(removed, "transcode finished jobs cleared");
        if removed > 0 {
            let _ = self.inner.events.send(TranscodeEvent::JobsCleared);
        }
        removed
    }
}

#[derive(Default)]
struct ProgressState {
    out_time_us: i64,
    speed: Option<f64>,
    fps: Option<f64>,
    output_bytes: u64,
    bitrate_kbps: Option<u64>,
}

impl ProgressState {
    /// Returns true when FFmpeg finishes a progress block.
    fn apply(&mut self, line: &str) -> bool {
        if let Some(value) = line.strip_prefix("out_time_us=") {
            self.out_time_us = value.trim().parse::<i64>().unwrap_or(0).max(0);
        } else if let Some(value) = line.strip_prefix("out_time_ms=") {
            if self.out_time_us == 0 {
                self.out_time_us = value.trim().parse::<i64>().unwrap_or(0).max(0);
            }
        } else if let Some(value) = line.strip_prefix("speed=") {
            self.speed = parse_speed(value);
        } else if let Some(value) = line.strip_prefix("fps=") {
            self.fps = value
                .trim()
                .trim_end_matches('x')
                .parse::<f64>()
                .ok()
                .filter(|fps| *fps > 0.0);
        } else if let Some(value) = line.strip_prefix("total_size=") {
            self.output_bytes = value.trim().parse::<u64>().unwrap_or(0);
        } else if let Some(value) = line.strip_prefix("bitrate=") {
            self.bitrate_kbps = parse_bitrate(value);
        }
        line.starts_with("progress=")
    }

    fn snapshot(&self) -> ProgressSnapshot {
        ProgressSnapshot {
            out_time_us: self.out_time_us,
            speed: self.speed,
            fps: self.fps,
            output_bytes: self.output_bytes,
            bitrate_kbps: self.bitrate_kbps,
        }
    }
}

struct ProgressSnapshot {
    out_time_us: i64,
    speed: Option<f64>,
    fps: Option<f64>,
    output_bytes: u64,
    bitrate_kbps: Option<u64>,
}

impl ProgressSnapshot {
    fn apply(&self, view: &mut JobView) {
        let out_time_ms = self.out_time_us / 1000;
        view.out_time_ms = out_time_ms;
        if view.duration_ms > 0 {
            view.progress = ((out_time_ms as f64 / view.duration_ms as f64) * 100.0)
                .clamp(0.0, 99.9);
            view.eta_seconds = self.speed.filter(|speed| *speed > 0.01).map(|speed| {
                ((view.duration_ms - out_time_ms).max(0) as f64 / 1000.0 / speed).max(0.0)
            });
        }
        view.speed = self.speed;
        view.fps = self.fps;
        view.output_bytes = self.output_bytes;
        view.current_bitrate_kbps = self.bitrate_kbps;
    }
}

fn parse_speed(value: &str) -> Option<f64> {
    let value = value.trim().trim_end_matches('x').trim();
    if value.is_empty() || value.eq_ignore_ascii_case("N/A") {
        return None;
    }
    value.parse::<f64>().ok().filter(|speed| *speed > 0.0)
}

fn parse_bitrate(value: &str) -> Option<u64> {
    let value = value.trim();
    let number = value
        .trim_end_matches("kbits/s")
        .trim_end_matches("kbit/s")
        .trim()
        .trim_end_matches('k');
    let parsed = number.parse::<f64>().ok()?;
    if parsed <= 0.0 {
        None
    } else {
        Some(parsed.round() as u64)
    }
}

fn replacement_backup_path(output: &Path) -> PathBuf {
    let name = output
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".to_string());
    output.with_file_name(format!(
        "{name}.transcode-backup-{}",
        uuid::Uuid::new_v4().simple()
    ))
}

fn same_path(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

fn encoder_open_failure(stderr: &str) -> bool {
    let text = stderr.to_ascii_lowercase();
    text.contains("error while opening encoder")
        || text.contains("could not open encoder")
        || text.contains("error initializing output stream")
        || text.contains("failed to configure output pad")
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_progress_lines() {
        let mut state = ProgressState::default();
        state.apply("fps=25.0");
        state.apply("bitrate=4200.5kbits/s");
        state.apply("total_size=1048576");
        state.apply("out_time_us=12000000");
        state.apply("speed=2.5x");
        assert!(state.apply("progress=continue"));
        let snapshot = state.snapshot();
        let mut view = JobView {
            id: String::new(),
            source_path: String::new(),
            source_name: String::new(),
            output_path: String::new(),
            source_codec: String::new(),
            source_width: 0,
            source_height: 0,
            source_bytes: 0,
            source_bitrate_kbps: 0,
            target_codec: String::new(),
            container: String::new(),
            resolution: String::new(),
            encoder: String::new(),
            hardware: false,
            accel: None,
            vendor: None,
            bitrate_kbps: 0,
            quality: None,
            audio: String::new(),
            delete_original: false,
            status: "running".to_string(),
            progress: 0.0,
            duration_ms: 24000,
            out_time_ms: 0,
            speed: None,
            fps: None,
            eta_seconds: None,
            output_bytes: 0,
            current_bitrate_kbps: None,
            estimated_bytes: 0,
            error: None,
            note: None,
            created_at: 0,
            started_at: None,
            finished_at: None,
        };
        snapshot.apply(&mut view);
        assert_eq!(view.out_time_ms, 12000);
        assert!((view.progress - 50.0).abs() < 0.1);
        assert_eq!(view.speed, Some(2.5));
        assert_eq!(view.fps, Some(25.0));
        assert_eq!(view.output_bytes, 1048576);
        assert_eq!(view.current_bitrate_kbps, Some(4201));
        assert_eq!(view.eta_seconds, Some(4.8));
    }

    #[test]
    fn parses_na_speed() {
        let mut state = ProgressState::default();
        state.apply("speed=N/A");
        assert_eq!(state.speed, None);
    }
}
