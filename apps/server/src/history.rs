use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

const MAX_RECORDS: usize = 200;
const MAX_ITEMS: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub name: String,
    pub status: String,
    pub source_bytes: u64,
    pub output_bytes: u64,
    pub duration_ms: i64,
    pub output_path: String,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub id: String,
    /// "video" or "image"
    pub kind: String,
    pub summary: String,
    pub started_at: i64,
    pub finished_at: i64,
    pub duration_ms: i64,
    pub total: usize,
    pub done: usize,
    pub failed: usize,
    pub canceled: usize,
    pub source_bytes: u64,
    pub output_bytes: u64,
    pub saved_bytes: i64,
    pub saved_percent: Option<f64>,
    #[serde(default)]
    pub items: Vec<HistoryItem>,
}

pub struct HistoryService {
    path: PathBuf,
    records: RwLock<Vec<HistoryRecord>>,
}

impl HistoryService {
    pub fn new(data_dir: &Path) -> Arc<Self> {
        let path = data_dir.join("conversion-history.json");
        let records = match std::fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<Vec<HistoryRecord>>(&raw) {
                Ok(records) => records,
                Err(error) => {
                    tracing::warn!(%error, path = %path.display(), "忽略无法解析的转换归档日志");
                    Vec::new()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                tracing::warn!(%error, path = %path.display(), "读取转换归档日志失败");
                Vec::new()
            }
        };
        Arc::new(Self {
            path,
            records: RwLock::new(records),
        })
    }

    pub async fn list(&self, limit: usize) -> Vec<HistoryRecord> {
        let records = self.records.read().await;
        let limit = limit.clamp(1, MAX_RECORDS);
        records.iter().take(limit).cloned().collect()
    }

    pub async fn add(&self, mut record: HistoryRecord) {
        record.items.truncate(MAX_ITEMS);
        let snapshot = {
            let mut records = self.records.write().await;
            records.insert(0, record);
            records.truncate(MAX_RECORDS);
            records.clone()
        };
        if let Err(error) = self.persist(&snapshot).await {
            tracing::warn!(%error, "保存转换归档日志失败");
        }
    }

    pub async fn clear(&self) -> usize {
        let removed = {
            let mut records = self.records.write().await;
            let removed = records.len();
            records.clear();
            removed
        };
        if let Err(error) = self.persist(&[]).await {
            tracing::warn!(%error, "清空转换归档日志失败");
        }
        removed
    }

    async fn persist(&self, records: &[HistoryRecord]) -> Result<(), String> {
        let json = serde_json::to_string_pretty(records)
            .map_err(|error| format!("序列化归档日志失败: {error}"))?;
        let temp = self.path.with_extension("json.tmp");
        tokio::fs::write(&temp, json)
            .await
            .map_err(|error| format!("写入归档日志失败: {error}"))?;
        tokio::fs::rename(&temp, &self.path)
            .await
            .map_err(|error| format!("替换归档日志失败: {error}"))
    }
}

pub fn record_from_jobs(
    kind: &str,
    summary: String,
    started_at: i64,
    finished_at: i64,
    jobs: &[crate::transcode::JobView],
) -> HistoryRecord {
    let done_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| job.status == "done")
        .collect();
    let source_bytes: u64 = done_jobs.iter().map(|job| job.source_bytes).sum();
    let output_bytes: u64 = done_jobs.iter().map(|job| job.output_bytes).sum();
    let saved_bytes = source_bytes as i64 - output_bytes as i64;
    let saved_percent = if source_bytes > 0 {
        Some(saved_bytes as f64 / source_bytes as f64 * 100.0)
    } else {
        None
    };
    let mut items: Vec<HistoryItem> = jobs
        .iter()
        .map(|job| HistoryItem {
            name: job.source_name.clone(),
            status: job.status.clone(),
            source_bytes: job.source_bytes,
            output_bytes: job.output_bytes,
            duration_ms: match (job.started_at, job.finished_at) {
                (Some(start), Some(end)) => (end - start).max(0),
                _ => 0,
            },
            output_path: job.output_path.clone(),
            error: job.error.clone(),
        })
        .collect();
    items.sort_by(|left, right| left.name.cmp(&right.name));
    HistoryRecord {
        id: uuid::Uuid::new_v4().to_string(),
        kind: kind.to_string(),
        summary,
        started_at,
        finished_at,
        duration_ms: (finished_at - started_at).max(0),
        total: jobs.len(),
        done: done_jobs.len(),
        failed: jobs.iter().filter(|job| job.status == "failed").count(),
        canceled: jobs
            .iter()
            .filter(|job| job.status == "canceled")
            .count(),
        source_bytes,
        output_bytes,
        saved_bytes,
        saved_percent,
        items,
    }
}

pub fn record_from_image_jobs(
    summary: String,
    started_at: i64,
    finished_at: i64,
    jobs: &[crate::images::ImageJobView],
) -> HistoryRecord {
    let done_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| job.status == "done")
        .collect();
    let source_bytes: u64 = done_jobs.iter().map(|job| job.source_bytes).sum();
    let output_bytes: u64 = done_jobs.iter().map(|job| job.output_bytes).sum();
    let saved_bytes = source_bytes as i64 - output_bytes as i64;
    let saved_percent = if source_bytes > 0 {
        Some(saved_bytes as f64 / source_bytes as f64 * 100.0)
    } else {
        None
    };
    let mut items: Vec<HistoryItem> = jobs
        .iter()
        .map(|job| HistoryItem {
            name: job.source_name.clone(),
            status: job.status.clone(),
            source_bytes: job.source_bytes,
            output_bytes: job.output_bytes,
            duration_ms: match (job.started_at, job.finished_at) {
                (Some(start), Some(end)) => (end - start).max(0),
                _ => 0,
            },
            output_path: job.output_path.clone(),
            error: job.error.clone(),
        })
        .collect();
    items.sort_by(|left, right| left.name.cmp(&right.name));
    HistoryRecord {
        id: uuid::Uuid::new_v4().to_string(),
        kind: "image".to_string(),
        summary,
        started_at,
        finished_at,
        duration_ms: (finished_at - started_at).max(0),
        total: jobs.len(),
        done: done_jobs.len(),
        failed: jobs.iter().filter(|job| job.status == "failed").count(),
        canceled: jobs
            .iter()
            .filter(|job| job.status == "canceled")
            .count(),
        source_bytes,
        output_bytes,
        saved_bytes,
        saved_percent,
        items,
    }
}
