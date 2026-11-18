use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use walkdir::WalkDir;

use super::exec;
use super::ScanTracker;

const VIDEO_EXTENSIONS: &[&str] = &[
    "mkv", "mp4", "m4v", "mov", "avi", "wmv", "flv", "webm", "ts", "m2ts", "mts", "mpg", "mpeg",
    "vob", "rmvb", "rm", "3gp", "ogv", "divx", "asf",
];

const SCAN_CONCURRENCY: usize = 4;
const PROBE_TIMEOUT_SECS: u64 = 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFile {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub modified_at: i64,
    pub container: String,
    pub duration_ms: i64,
    pub video_codec: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub video_bitrate_bps: u64,
    pub pix_fmt: String,
    pub bit_depth: u32,
    pub is_hdr: bool,
    pub audio_codec: Option<String>,
    pub audio_channels: u32,
    pub subtitle_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub directory: String,
    pub scanned: usize,
    pub matched: usize,
    pub skipped_by_size: usize,
    pub files: Vec<MediaFile>,
    pub errors: Vec<String>,
    pub took_ms: u64,
}

pub async fn scan(
    ffprobe: &Path,
    directory: &str,
    recursive: bool,
    source_codec: Option<&str>,
    min_size_bytes: u64,
    cache: Option<&RwLock<HashMap<String, MediaFile>>>,
    progress: Option<Arc<ScanTracker>>,
) -> Result<ScanResult, String> {
    let started = std::time::Instant::now();
    let directory = directory.trim();
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

    let mut paths = Vec::new();
    let mut skipped_by_size = 0;
    let max_depth = if recursive { usize::MAX } else { 1 };
    for entry in WalkDir::new(&directory_path)
        .max_depth(max_depth)
        .follow_links(false)
        .into_iter()
        .flatten()
    {
        if !entry.file_type().is_file() || !has_video_extension(entry.path()) {
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
    let filter = source_codec
        .map(normalize_codec)
        .filter(|codec| !codec.is_empty() && codec != "all");
    let scan_concurrency = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(SCAN_CONCURRENCY)
        .clamp(SCAN_CONCURRENCY, 12);
    if let Some(progress) = progress.as_ref() {
        progress.begin(scanned, skipped_by_size).await;
    }
    tracing::debug!(
        directory = %directory_path.display(),
        files = scanned,
        concurrency = scan_concurrency,
        cached = cache.is_some(),
        "transcode scan probing files"
    );

    let results = stream::iter(paths.into_iter().map(|path| {
        let progress = progress.clone();
        async move {
            let key = path.to_string_lossy().to_string();
            let cached = if let Some(cache) = cache {
                let guard = cache.read().await;
                guard
                    .get(&key)
                    .cloned()
                    .filter(|media| file_matches(&path, media))
            } else {
                None
            };
            let result = match cached {
                Some(media) => {
                    if let Some(progress) = progress.as_ref() {
                        progress.advance(true).await;
                    }
                    Ok(Some(media))
                }
                None => {
                    let result = probe_file(ffprobe, &path).await;
                    if let Some(progress) = progress.as_ref() {
                        progress.advance(false).await;
                    }
                    result
                }
            };
            if let (Ok(Some(media)), Some(cache)) = (&result, cache) {
                cache
                    .write()
                    .await
                    .insert(media.path.clone(), media.clone());
            }
            (path, result)
        }
    }))
    .buffer_unordered(scan_concurrency)
    .collect::<Vec<_>>()
    .await;

    let mut files = Vec::new();
    let mut errors = Vec::new();
    for (path, result) in results {
        match result {
            Ok(Some(media)) => {
                if let Some(filter) = filter.as_deref() {
                    if normalize_codec(&media.video_codec) != filter {
                        continue;
                    }
                }
                files.push(media);
            }
            Ok(None) => {}
            Err(error) => {
                if errors.len() < 20 {
                    errors.push(format!("{}: {error}", path.display()));
                }
            }
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));

    Ok(ScanResult {
        directory: directory_path.to_string_lossy().to_string(),
        scanned,
        matched: files.len(),
        skipped_by_size,
        files,
        errors,
        took_ms: started.elapsed().as_millis() as u64,
    })
}

pub async fn probe_file(ffprobe: &Path, path: &Path) -> Result<Option<MediaFile>, String> {
    let args = vec![
        "-v".into(),
        "error".into(),
        "-print_format".into(),
        "json".into(),
        "-show_format".into(),
        "-show_streams".into(),
        path.as_os_str().to_os_string(),
    ];
    let output = exec::run_os(ffprobe, &args, Duration::from_secs(PROBE_TIMEOUT_SECS)).await?;
    if !output.success {
        return Ok(None);
    }
    let text = output.stdout.trim();
    if text.is_empty() {
        return Ok(None);
    }
    let parsed: FfprobeOutput = serde_json::from_str(text)
        .map_err(|error| format!("ffprobe JSON 解析失败: {error}"))?;

    let Some(video) = parsed.streams.iter().find(|stream| {
        stream.codec_type.as_deref() == Some("video")
            && stream
                .disposition
                .as_ref()
                .map(|disposition| disposition.attached_pic)
                .unwrap_or(0)
                == 0
    }) else {
        return Ok(None);
    };

    let format = parsed.format.as_ref();
    let duration_s = format
        .and_then(|format| parse_f64(format.duration.as_deref()))
        .or_else(|| parse_f64(video.duration.as_deref()))
        .unwrap_or(0.0);
    let size_bytes = format
        .and_then(|format| parse_u64(format.size.as_deref()))
        .or_else(|| std::fs::metadata(path).ok().map(|metadata| metadata.len()))
        .unwrap_or(0);
    let video_bitrate_bps = parse_u64(video.bit_rate.as_deref())
        .or_else(|| format.and_then(|format| parse_u64(format.bit_rate.as_deref())))
        .unwrap_or_else(|| {
            if duration_s > 0.0 {
                (size_bytes as f64 * 8.0 / duration_s) as u64
            } else {
                0
            }
        });

    let audio = parsed
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("audio"));
    let audio_codec = audio.and_then(|stream| stream.codec_name.clone());
    let audio_channels = audio.and_then(|stream| stream.channels).unwrap_or(0);
    let subtitle_count = parsed
        .streams
        .iter()
        .filter(|stream| stream.codec_type.as_deref() == Some("subtitle"))
        .count() as u32;

    let pix_fmt = video.pix_fmt.clone().unwrap_or_default();
    let color_transfer = video.color_transfer.clone().unwrap_or_default();
    let color_primaries = video.color_primaries.clone().unwrap_or_default();
    let is_hdr = matches!(
        color_transfer.to_ascii_lowercase().as_str(),
        "smpte2084" | "arib-std-b67"
    ) || color_primaries.eq_ignore_ascii_case("bt2020");

    let metadata = std::fs::metadata(path).ok();
    let modified_at = metadata
        .as_ref()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);

    Ok(Some(MediaFile {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string()),
        size_bytes,
        modified_at,
        container: format
            .and_then(|format| format.format_name.as_deref())
            .map(container_label)
            .unwrap_or_else(|| "未知".to_string()),
        duration_ms: (duration_s * 1000.0).round() as i64,
        video_codec: video.codec_name.clone().unwrap_or_else(|| "unknown".to_string()),
        width: video.width.unwrap_or(0),
        height: video.height.unwrap_or(0),
        fps: parse_rate(video.avg_frame_rate.as_deref())
            .max(parse_rate(video.r_frame_rate.as_deref())),
        video_bitrate_bps,
        bit_depth: bit_depth(&pix_fmt),
        pix_fmt,
        is_hdr,
        audio_codec,
        audio_channels,
        subtitle_count,
    }))
}

pub fn normalize_codec(codec: &str) -> String {
    match codec.trim().to_ascii_lowercase().as_str() {
        "h265" | "h.265" => "hevc".to_string(),
        "h264" | "h.264" | "avc" => "h264".to_string(),
        other => other.to_string(),
    }
}

fn has_video_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| VIDEO_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn file_matches(path: &Path, media: &MediaFile) -> bool {
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
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64 == media.modified_at)
        .unwrap_or(false)
}

fn parse_u64(value: Option<&str>) -> Option<u64> {
    value?.trim().parse::<u64>().ok()
}

fn parse_f64(value: Option<&str>) -> Option<f64> {
    value?.trim().parse::<f64>().ok()
}

fn parse_rate(value: Option<&str>) -> f64 {
    let Some(value) = value else {
        return 0.0;
    };
    if let Some((numerator, denominator)) = value.split_once('/') {
        let numerator = numerator.trim().parse::<f64>().unwrap_or(0.0);
        let denominator = denominator.trim().parse::<f64>().unwrap_or(0.0);
        if denominator > 0.0 {
            numerator / denominator
        } else {
            0.0
        }
    } else {
        value.trim().parse::<f64>().unwrap_or(0.0)
    }
}

fn bit_depth(pix_fmt: &str) -> u32 {
    if pix_fmt.contains("12") {
        12
    } else if pix_fmt.contains("10") {
        10
    } else {
        8
    }
}

fn container_label(format_name: &str) -> String {
    let name = format_name.to_ascii_lowercase();
    if name.contains("matroska") || name.contains("webm") {
        "MKV".to_string()
    } else if name.contains("mp4") || name.contains("mov") {
        "MP4".to_string()
    } else if name.contains("mpegts") {
        "TS".to_string()
    } else if name.contains("avi") {
        "AVI".to_string()
    } else if name.contains("flv") {
        "FLV".to_string()
    } else if name.contains("asf") {
        "ASF".to_string()
    } else {
        format_name.to_string()
    }
}

#[derive(Deserialize)]
struct FfprobeOutput {
    #[serde(default)]
    streams: Vec<FfprobeStream>,
    format: Option<FfprobeFormat>,
}

#[derive(Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    bit_rate: Option<String>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    duration: Option<String>,
    pix_fmt: Option<String>,
    color_transfer: Option<String>,
    color_primaries: Option<String>,
    channels: Option<u32>,
    disposition: Option<FfprobeDisposition>,
}

#[derive(Deserialize, Default)]
struct FfprobeDisposition {
    #[serde(default)]
    attached_pic: i64,
}

#[derive(Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
    size: Option<String>,
    bit_rate: Option<String>,
    format_name: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_codec_names() {
        assert_eq!(normalize_codec("H.265"), "hevc");
        assert_eq!(normalize_codec("h264"), "h264");
        assert_eq!(normalize_codec("AV1"), "av1");
    }

    #[test]
    fn parses_rational_rates() {
        assert!((parse_rate(Some("30000/1001")) - 29.97).abs() < 0.01);
        assert!((parse_rate(Some("25")) - 25.0).abs() < 0.001);
        assert_eq!(parse_rate(Some("0/0")), 0.0);
    }

    #[test]
    fn detects_bit_depth_and_hdr() {
        assert_eq!(bit_depth("yuv420p10le"), 10);
        assert_eq!(bit_depth("p010le"), 10);
        assert_eq!(bit_depth("yuv420p"), 8);
    }

    #[test]
    fn labels_containers() {
        assert_eq!(container_label("matroska,webm"), "MKV");
        assert_eq!(container_label("mov,mp4,m4a,3gp,3g2,mj2"), "MP4");
        assert_eq!(container_label("mpegts"), "TS");
    }
}
