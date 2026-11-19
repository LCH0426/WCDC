use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::media::MediaFile;
use super::probe::TranscodeStatus;
#[cfg(test)]
use super::codecs::CodecSupport;
#[cfg(test)]
use super::probe::HwDevice;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscodeSettings {
    pub target_codec: String,
    pub container: String,
    #[serde(default = "default_encoder")]
    pub encoder: String,
    pub resolution: String,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    /// Fixed output frame rate; None/0 keeps the source rate.
    #[serde(default)]
    pub fps: Option<f64>,
    #[serde(default = "default_bitrate_mode")]
    pub bitrate_mode: String,
    #[serde(default)]
    pub bitrate_kbps: Option<u32>,
    #[serde(default)]
    pub crf: Option<u8>,
    #[serde(default = "default_audio")]
    pub audio: String,
    #[serde(default)]
    pub concurrency: Option<u32>,
    #[serde(default)]
    pub delete_original: bool,
    #[serde(default)]
    pub output_dir: Option<String>,
    #[serde(default)]
    pub hdr_to_sdr: Option<bool>,
    /// 0 / empty means "let ffmpeg decide"; otherwise limit decoder and
    /// software encoder worker threads.
    #[serde(default)]
    pub cpu_threads: Option<u32>,
}

fn default_encoder() -> String {
    "auto".to_string()
}

fn default_bitrate_mode() -> String {
    "source".to_string()
}

fn default_audio() -> String {
    "copy".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AudioMode {
    Copy,
    Aac,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedOptions {
    pub target_codec: String,
    pub container: String,
    pub encoder: String,
    pub hardware: bool,
    pub accel: Option<String>,
    pub vendor: Option<String>,
    pub device: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    #[serde(default)]
    pub fps: Option<f64>,
    pub resolution_label: String,
    pub bitrate_kbps: u64,
    pub crf: Option<u8>,
    pub audio: AudioMode,
    pub delete_original: bool,
    pub tonemap: bool,
    pub output_dir: Option<String>,
    pub concurrency: u32,
    pub cpu_threads: Option<u32>,
    /// Software encoder to use if the selected hardware encoder fails to open.
    pub software_fallback: Option<String>,
}

#[derive(Debug, Clone)]
struct ResolvedEncoder {
    name: String,
    hardware: bool,
    accel: Option<String>,
    vendor: Option<String>,
    device: Option<String>,
}

pub fn resolve(
    media: &MediaFile,
    settings: &TranscodeSettings,
    status: &TranscodeStatus,
) -> Result<ResolvedOptions, String> {
    let target_codec = normalize_codec(&settings.target_codec);
    if !matches!(target_codec.as_str(), "h264" | "hevc" | "av1" | "vp9" | "vp8") {
        return Err(format!("不支持的目标编码：{}", settings.target_codec));
    }
    let container = settings.container.trim().to_ascii_lowercase();
    if !matches!(container.as_str(), "mp4" | "mkv") {
        return Err("输出容器只支持 MP4 或 MKV".to_string());
    }
    if container == "mp4" && !matches!(target_codec.as_str(), "h264" | "hevc" | "av1") {
        return Err("VP9/VP8 请选择 MKV 容器".to_string());
    }

    let encoder = resolve_encoder(status, &target_codec, &settings.encoder)?;
    let software_fallback = software_encoder_for(status, &target_codec);
    let (width, height, resolution_label) = resolve_dimensions(media, settings)?;
    let bitrate_kbps = resolve_bitrate(media, settings);
    let crf = if settings.bitrate_mode.trim().eq_ignore_ascii_case("crf") {
        if !crf_supported(&encoder.name) {
            return Err(format!(
                "编码器 {} 不支持 CRF 质量模式，请改用“与原视频相同”或自定义码率",
                encoder.name
            ));
        }
        let max_crf = if matches!(target_codec.as_str(), "av1" | "vp9" | "vp8") {
            63
        } else {
            51
        };
        Some(
            settings
                .crf
                .unwrap_or_else(|| default_crf(&target_codec))
                .min(max_crf),
        )
    } else {
        None
    };
    let audio = resolve_audio(media, &container, &settings.audio);

    let fps = match settings.fps {
        Some(value) if value > 0.0 => {
            if !value.is_finite() || !(1.0..=240.0).contains(&value) {
                return Err("帧率必须在 1–240 之间".to_string());
            }
            Some(value)
        }
        _ => None,
    };

    let hdr_requested = settings.hdr_to_sdr.unwrap_or(true);
    let tonemap = media.is_hdr && hdr_requested;
    if tonemap && !status.build_config.iter().any(|flag| flag == "--enable-libzimg") {
        return Err(format!(
            "{} 是 HDR 视频，但当前 ffmpeg 未编译 zimg，无法做 HDR→SDR；请安装完整构建或在设置中关闭 HDR 转换",
            media.name
        ));
    }

    Ok(ResolvedOptions {
        target_codec,
        container,
        encoder: encoder.name,
        hardware: encoder.hardware,
        accel: encoder.accel,
        vendor: encoder.vendor,
        device: encoder.device,
        width,
        height,
        resolution_label,
        fps,
        bitrate_kbps,
        crf,
        audio,
        delete_original: settings.delete_original,
        tonemap,
        output_dir: settings
            .output_dir
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        concurrency: settings.concurrency.unwrap_or(1).clamp(1, 4),
        cpu_threads: settings
            .cpu_threads
            .map(|value| value.clamp(0, 64))
            .filter(|value| *value > 0),
        software_fallback,
    })
}

impl ResolvedOptions {
    /// Keep every output parameter but move to a software encoder. Used when a
    /// hardware encoder is advertised by ffmpeg but cannot actually open on the
    /// current driver / GPU (common with AV1 QSV on older Intel hardware).
    pub fn switch_to_software(&self, encoder: String) -> Self {
        let mut next = self.clone();
        next.encoder = encoder;
        next.hardware = false;
        next.accel = None;
        next.vendor = None;
        next.device = None;
        if next.crf.is_some() && !crf_supported(&next.encoder) {
            next.crf = None;
        }
        next
    }
}

/// Encoders that accept system-memory frames directly. D3D12VA/Vulkan/OpenCL
/// encoders need explicit hardware-frame upload, which is not wired up here.
const DIRECT_ENCODER_ACCELS: &[&str] = &[
    "nvenc", "qsv", "vaapi", "amf", "mf", "videotoolbox", "rkmpp", "v4l2m2m",
];

fn direct_encoder_accel(accel: &str) -> bool {
    DIRECT_ENCODER_ACCELS.contains(&accel)
}

fn normalize_codec(codec: &str) -> String {
    match codec.trim().to_ascii_lowercase().as_str() {
        "h265" | "h.265" => "hevc".to_string(),
        "h264" | "h.264" | "avc" => "h264".to_string(),
        other => other.to_string(),
    }
}

fn resolve_encoder(
    status: &TranscodeStatus,
    target_codec: &str,
    requested: &str,
) -> Result<ResolvedEncoder, String> {
    let codec = status
        .codecs
        .iter()
        .find(|codec| codec.codec == target_codec)
        .ok_or_else(|| format!("当前 ffmpeg 没有 {target_codec} 编码信息"))?;
    let requested = requested.trim();

    if !requested.is_empty() && !requested.eq_ignore_ascii_case("auto") {
        if let Some(implementation) = codec
            .encode
            .hardware
            .iter()
            .find(|implementation| implementation.name == requested)
        {
            if !direct_encoder_accel(&implementation.accel) {
                return Err(format!(
                    "编码器 {} 需要硬件帧上传，当前版本暂不支持，请改选其他编码器",
                    implementation.name
                ));
            }
            if !accel_usable(status, &implementation.accel) {
                return Err(format!(
                    "编码器 {} 当前不可用，请先运行硬件自检或改选其他编码器",
                    implementation.name
                ));
            }
            return Ok(ResolvedEncoder {
                name: implementation.name.clone(),
                hardware: true,
                accel: Some(implementation.accel.clone()),
                vendor: Some(implementation.vendor.clone()),
                device: device_for(status, &implementation.accel),
            });
        }
        if codec.encode.software.iter().any(|name| name == requested) {
            return Ok(ResolvedEncoder {
                name: requested.to_string(),
                hardware: false,
                accel: None,
                vendor: None,
                device: None,
            });
        }
        return Err(format!("当前 ffmpeg 不包含编码器 {requested}"));
    }

    let mut hardware: Vec<_> = codec
        .encode
        .hardware
        .iter()
        .filter(|implementation| {
            direct_encoder_accel(&implementation.accel)
                && accel_usable(status, &implementation.accel)
        })
        .collect();
    hardware.sort_by_key(|implementation| {
        (
            accel_rank(&implementation.accel),
            !accel_verified(status, &implementation.accel),
        )
    });
    if let Some(implementation) = hardware.first() {
        return Ok(ResolvedEncoder {
            name: implementation.name.clone(),
            hardware: true,
            accel: Some(implementation.accel.clone()),
            vendor: Some(implementation.vendor.clone()),
            device: device_for(status, &implementation.accel),
        });
    }

    for preferred in software_preference(target_codec) {
        if let Some(name) = codec
            .encode
            .software
            .iter()
            .find(|name| name.as_str() == *preferred)
        {
            return Ok(ResolvedEncoder {
                name: name.clone(),
                hardware: false,
                accel: None,
                vendor: None,
                device: None,
            });
        }
    }
    if let Some(name) = codec.encode.software.first() {
        return Ok(ResolvedEncoder {
            name: name.clone(),
            hardware: false,
            accel: None,
            vendor: None,
            device: None,
        });
    }

    Err(format!(
        "当前 ffmpeg 没有可用的 {target_codec} 编码器（硬件不可用且缺少软件编码器）"
    ))
}

fn software_preference(codec: &str) -> &'static [&'static str] {
    match codec {
        "h264" => &["libx264"],
        "hevc" => &["libx265"],
        "av1" => &["libsvtav1", "libaom-av1", "librav1e"],
        "vp9" => &["libvpx-vp9"],
        "vp8" => &["libvpx"],
        _ => &[],
    }
}

fn software_encoder_for(status: &TranscodeStatus, target_codec: &str) -> Option<String> {
    let codec = status
        .codecs
        .iter()
        .find(|codec| codec.codec == target_codec)?;
    for preferred in software_preference(target_codec) {
        if codec
            .encode
            .software
            .iter()
            .any(|name| name.as_str() == *preferred)
        {
            return Some((*preferred).to_string());
        }
    }
    codec.encode.software.first().cloned()
}

fn accel_usable(status: &TranscodeStatus, accel: &str) -> bool {
    status
        .devices
        .iter()
        .find(|device| device.accel == accel)
        .map(|device| device.available && device.verified != Some(false))
        .unwrap_or(false)
}

fn accel_verified(status: &TranscodeStatus, accel: &str) -> bool {
    status
        .devices
        .iter()
        .find(|device| device.accel == accel)
        .and_then(|device| device.verified)
        .unwrap_or(false)
}

fn device_for(status: &TranscodeStatus, accel: &str) -> Option<String> {
    status
        .devices
        .iter()
        .find(|device| device.accel == accel)
        .and_then(|device| device.device.clone())
}

fn accel_rank(accel: &str) -> usize {
    if cfg!(windows) {
        match accel {
            "nvenc" => 0,
            "qsv" => 1,
            "amf" => 2,
            "mf" => 3,
            _ => 9,
        }
    } else if cfg!(target_os = "macos") {
        match accel {
            "videotoolbox" => 0,
            _ => 9,
        }
    } else {
        match accel {
            "nvenc" => 0,
            "qsv" => 1,
            "vaapi" => 2,
            "rkmpp" => 3,
            "v4l2m2m" => 4,
            _ => 9,
        }
    }
}

fn resolve_dimensions(
    media: &MediaFile,
    settings: &TranscodeSettings,
) -> Result<(Option<u32>, Option<u32>, String), String> {
    let resolution = settings.resolution.trim().to_ascii_lowercase();
    if resolution == "source" || resolution == "original" || resolution.is_empty() {
        return Ok((None, None, "原始".to_string()));
    }
    if resolution == "custom" {
        let width = settings.width.filter(|value| *value >= 16).map(even);
        let height = settings.height.filter(|value| *value >= 16).map(even);
        if width.is_none() && height.is_none() {
            return Err("自定义分辨率需要填写宽或高（至少一个）".to_string());
        }
        let label = match (width, height) {
            (Some(width), Some(height)) => format!("{width}x{height}"),
            (Some(width), None) => format!("{width}px 宽"),
            (None, Some(height)) => format!("{height}p"),
            (None, None) => "原始".to_string(),
        };
        return Ok((width, height, label));
    }
    let height = match resolution.as_str() {
        "2160p" | "4k" => 2160,
        "1440p" | "2k" => 1440,
        "1080p" => 1080,
        "720p" => 720,
        "480p" => 480,
        "360p" => 360,
        _ => return Err(format!("未知分辨率：{}", settings.resolution)),
    };
    if media.height > 0 && media.height <= height {
        return Ok((None, None, "原始（不放大）".to_string()));
    }
    Ok((None, Some(even(height)), format!("{height}p")))
}

fn even(value: u32) -> u32 {
    if value % 2 == 0 {
        value
    } else {
        value.saturating_sub(1)
    }
}

fn resolve_bitrate(media: &MediaFile, settings: &TranscodeSettings) -> u64 {
    if settings.bitrate_mode.trim().eq_ignore_ascii_case("custom") {
        return u64::from(settings.bitrate_kbps.unwrap_or(0).clamp(100, 100_000));
    }
    let source = media.video_bitrate_bps / 1000;
    if source > 0 {
        source.clamp(100, 200_000)
    } else {
        2500
    }
}

fn default_crf(codec: &str) -> u8 {
    match codec {
        "h264" => 23,
        "hevc" => 26,
        "av1" => 30,
        "vp9" | "vp8" => 32,
        _ => 23,
    }
}

fn crf_supported(encoder: &str) -> bool {
    let encoder = encoder.to_ascii_lowercase();
    encoder.starts_with("libx264")
        || encoder.starts_with("libx265")
        || encoder.starts_with("libsvtav1")
        || encoder.starts_with("libaom-av1")
        || encoder.starts_with("libvpx")
        || encoder.ends_with("_nvenc")
        || encoder.ends_with("_qsv")
        || encoder.ends_with("_vaapi")
        || encoder.ends_with("_amf")
}

fn resolve_audio(media: &MediaFile, container: &str, requested: &str) -> AudioMode {
    if media.audio_codec.is_none() {
        return AudioMode::None;
    }
    match requested.trim().to_ascii_lowercase().as_str() {
        "none" => AudioMode::None,
        "aac" => AudioMode::Aac,
        _ => {
            let codec = media
                .audio_codec
                .as_deref()
                .unwrap_or_default()
                .to_ascii_lowercase();
            if container == "mkv"
                || matches!(
                    codec.as_str(),
                    "aac" | "mp3" | "ac3" | "eac3" | "alac"
                )
            {
                AudioMode::Copy
            } else {
                AudioMode::Aac
            }
        }
    }
}

pub fn output_path(source: &Path, options: &ResolvedOptions) -> Result<PathBuf, String> {
    output_path_reserving(source, options, &HashSet::new())
}

pub fn output_path_reserving(
    source: &Path,
    options: &ResolvedOptions,
    reserved: &HashSet<PathBuf>,
) -> Result<PathBuf, String> {
    let directory = options
        .output_dir
        .as_deref()
        .map(PathBuf::from)
        .or_else(|| source.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建输出目录 {}: {error}", directory.display()))?;

    let stem = source
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "output".to_string());
    let extension = output_extension(&options.container);

    let replaces_source = options.delete_original;
    let is_taken = |path: &Path| {
        let reserved_taken = reserved.iter().any(|reserved| same_path(reserved, path));
        if same_path(path, source) {
            // With delete-original the new file may take the old file's name;
            // the old file is replaced only after a successful transcode.
            reserved_taken || !replaces_source
        } else {
            path.exists() || reserved_taken
        }
    };

    let mut candidate = directory.join(format!("{stem}.{extension}"));
    if is_taken(&candidate) {
        candidate = directory.join(format!("{stem}.{}.{extension}", options.target_codec));
    }
    let mut index = 2;
    while is_taken(&candidate) {
        candidate = directory.join(format!(
            "{stem}.{}-{index}.{extension}",
            options.target_codec
        ));
        index += 1;
    }
    Ok(candidate)
}

fn same_path(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

pub fn output_extension(container: &str) -> &'static str {
    if container == "mkv" {
        "mkv"
    } else {
        "mp4"
    }
}

pub fn container_format(container: &str) -> &'static str {
    if container == "mkv" {
        "matroska"
    } else {
        "mp4"
    }
}

pub fn estimated_bytes(options: &ResolvedOptions, media: &MediaFile) -> u64 {
    let seconds = (media.duration_ms.max(0) as f64) / 1000.0;
    let video = options.bitrate_kbps as f64 * 1000.0 / 8.0 * seconds;
    let audio = match options.audio {
        AudioMode::None => 0.0,
        AudioMode::Aac => 192_000.0 / 8.0 * seconds,
        AudioMode::Copy => 256_000.0 / 8.0 * seconds,
    };
    (video + audio) as u64
}

pub fn temp_path(output: &Path) -> PathBuf {
    let mut name = output
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".to_string());
    name.push_str(".part");
    output.with_file_name(name)
}

pub fn build_args(
    media: &MediaFile,
    options: &ResolvedOptions,
    temp: &Path,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::new();
    for value in [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        "-nostats",
    ] {
        args.push(value.into());
    }

    if options.accel.as_deref() == Some("vaapi") {
        args.push("-vaapi_device".into());
        args.push(
            options
                .device
                .clone()
                .unwrap_or_else(|| "/dev/dri/renderD128".to_string())
                .into(),
        );
    }

    // Before -i this applies to the decoder. It keeps CPU use bounded even
    // when hardware output is unavailable or when only software encoders exist.
    if let Some(threads) = options.cpu_threads {
        args.push("-threads".into());
        args.push(threads.to_string().into());
    }

    args.push("-i".into());
    args.push(media.path.clone().into());

    for value in [
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-map_metadata",
        "0",
        "-map_chapters",
        "0",
        "-sn",
    ] {
        args.push(value.into());
    }

    args.push("-c:v".into());
    args.push(options.encoder.clone().into());

    if options.encoder.starts_with("libx264") || options.encoder.starts_with("libx265") {
        args.push("-preset".into());
        args.push("medium".into());
    } else if options.encoder.ends_with("_nvenc") {
        args.push("-preset".into());
        args.push("p5".into());
    }

    if !options.hardware {
        if let Some(threads) = options.cpu_threads {
            // After -c:v this limits the encoder worker count as well.
            args.push("-threads".into());
            args.push(threads.to_string().into());
        }
    }

    let filters = build_filters(media, options);
    if !filters.is_empty() {
        args.push("-vf".into());
        args.push(filters.join(",").into());
    }

    if let Some(crf) = options.crf {
        append_quality_args(&mut args, &options.encoder, crf);
    } else if options.bitrate_kbps > 0 {
        let bitrate = options.bitrate_kbps;
        args.push("-b:v".into());
        args.push(format!("{bitrate}k").into());
        args.push("-maxrate".into());
        args.push(format!("{}k", (bitrate as f64 * 1.5).round() as u64).into());
        args.push("-bufsize".into());
        args.push(format!("{}k", bitrate.saturating_mul(2)).into());
    }

    match options.audio {
        AudioMode::None => {
            args.push("-an".into());
        }
        AudioMode::Copy => {
            args.push("-c:a".into());
            args.push("copy".into());
        }
        AudioMode::Aac => {
            args.push("-c:a".into());
            args.push("aac".into());
            args.push("-b:a".into());
            args.push("192k".into());
        }
    }

    if options.target_codec == "hevc" && options.container == "mp4" {
        args.push("-tag:v".into());
        args.push("hvc1".into());
    }

    args.push("-max_muxing_queue_size".into());
    args.push("1024".into());
    args.push("-f".into());
    args.push(container_format(&options.container).into());
    if options.container == "mp4" {
        args.push("-movflags".into());
        args.push("+faststart".into());
    }

    args.push(temp.as_os_str().to_os_string());
    args
}

fn append_quality_args(args: &mut Vec<OsString>, encoder: &str, crf: u8) {
    let encoder = encoder.to_ascii_lowercase();
    let value = crf.to_string();
    if encoder.ends_with("_nvenc") {
        args.extend(["-rc", "vbr", "-cq", value.as_str(), "-b:v", "0"].map(OsString::from));
    } else if encoder.ends_with("_qsv") {
        args.extend(["-global_quality", value.as_str()].map(OsString::from));
    } else if encoder.ends_with("_vaapi") {
        args.extend(["-qp", value.as_str()].map(OsString::from));
    } else if encoder.ends_with("_amf") {
        args.extend(
            ["-rc", "cqp", "-qp_i", value.as_str(), "-qp_p", value.as_str()]
                .map(OsString::from),
        );
    } else if encoder.starts_with("libaom-av1") || encoder.starts_with("libvpx") {
        args.extend(["-crf", value.as_str(), "-b:v", "0"].map(OsString::from));
    } else {
        args.extend(["-crf", value.as_str()].map(OsString::from));
    }
}

fn build_filters(media: &MediaFile, options: &ResolvedOptions) -> Vec<String> {
    let mut filters = Vec::new();
    if options.tonemap {
        filters.push(
            "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
                .to_string(),
        );
    }
    if let Some(scale) = scale_filter(options) {
        filters.push(scale);
    }
    if let Some(fps) = options.fps {
        filters.push(fps_filter(fps));
    }
    if options.accel.as_deref() == Some("vaapi") {
        filters.push("format=nv12".to_string());
        filters.push("hwupload".to_string());
    } else if options.accel.as_deref() == Some("qsv") {
        // QSV encoders (notably av1_qsv) accept nv12/p010le/qsv, not yuv420p.
        // Feeding yuv420p makes FFmpeg fail while opening the encoder.
        filters.push("format=nv12".to_string());
    } else {
        filters.push("format=yuv420p".to_string());
    }
    let _ = media;
    filters
}

fn scale_filter(options: &ResolvedOptions) -> Option<String> {
    match (options.width, options.height) {
        (Some(width), Some(height)) => Some(format!("scale={width}:{height}:flags=lanczos")),
        (Some(width), None) => Some(format!("scale={width}:-2:flags=lanczos")),
        (None, Some(height)) => Some(format!("scale=-2:{height}:flags=lanczos")),
        (None, None) => None,
    }
}

fn fps_filter(fps: f64) -> String {
    if (fps - 23.976).abs() < 0.001 {
        "fps=24000/1001".to_string()
    } else if (fps - 29.97).abs() < 0.001 {
        "fps=30000/1001".to_string()
    } else if (fps - 59.94).abs() < 0.001 {
        "fps=60000/1001".to_string()
    } else if fps.fract().abs() < 0.001 {
        format!("fps={:.0}", fps)
    } else {
        format!("fps={fps:.3}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media() -> MediaFile {
        MediaFile {
            path: "/tmp/movie.mkv".to_string(),
            name: "movie.mkv".to_string(),
            size_bytes: 1_000_000_000,
            modified_at: 0,
            container: "MKV".to_string(),
            duration_ms: 3_600_000,
            video_codec: "h264".to_string(),
            width: 1920,
            height: 1080,
            fps: 23.976,
            video_bitrate_bps: 8_000_000,
            pix_fmt: "yuv420p".to_string(),
            bit_depth: 8,
            is_hdr: false,
            audio_codec: Some("aac".to_string()),
            audio_channels: 2,
            subtitle_count: 0,
        }
    }

    fn settings() -> TranscodeSettings {
        TranscodeSettings {
            target_codec: "hevc".to_string(),
            container: "mp4".to_string(),
            encoder: "auto".to_string(),
            resolution: "source".to_string(),
            width: None,
            height: None,
            fps: None,
            bitrate_mode: "source".to_string(),
            bitrate_kbps: None,
            crf: None,
            audio: "copy".to_string(),
            concurrency: Some(2),
            delete_original: false,
            output_dir: None,
            hdr_to_sdr: Some(true),
            cpu_threads: None,
        }
    }

    fn status_with(encoder: &str, accel: &str) -> TranscodeStatus {
        TranscodeStatus {
            platform: "Linux".to_string(),
            arch: "x86_64".to_string(),
            found: true,
            path: Some("/usr/bin/ffmpeg".to_string()),
            source: "path".to_string(),
            ffprobe_path: Some("/usr/bin/ffprobe".to_string()),
            version: Some("7".to_string()),
            build_config: vec!["--enable-libx265".to_string()],
            hwaccels: vec![accel.to_string()],
            gpus: Vec::new(),
            devices: vec![HwDevice {
                accel: accel.to_string(),
                label: accel.to_string(),
                vendor: "intel".to_string(),
                vendor_label: "Intel".to_string(),
                device: if accel == "vaapi" {
                    Some("/dev/dri/renderD128".to_string())
                } else {
                    None
                },
                available: true,
                declared: true,
                verified: Some(true),
                note: None,
            }],
            codecs: vec![CodecSupport {
                codec: "hevc".to_string(),
                label: "H.265 / HEVC".to_string(),
                decode: Default::default(),
                encode: super::super::codecs::CodecImpls {
                    software: vec!["libx265".to_string()],
                    hardware: vec![super::super::codecs::HwImpl {
                        name: encoder.to_string(),
                        accel: accel.to_string(),
                        vendor: "intel".to_string(),
                        vendor_label: "Intel".to_string(),
                    }],
                },
            }],
            candidates: Vec::new(),
            install: Vec::new(),
            checked_at: 0,
            probe_ms: 0,
            error: None,
        }
    }

    #[test]
    fn picks_hardware_automatically() {
        let status = status_with("hevc_qsv", "qsv");
        let options = resolve(&media(), &settings(), &status).unwrap();
        assert_eq!(options.encoder, "hevc_qsv");
        assert!(options.hardware);
        assert_eq!(options.bitrate_kbps, 8000);
    }

    #[test]
    fn builds_crf_args_for_software_and_nvenc() {
        let software = status_with("libx265", "qsv");
        let mut options = settings();
        options.bitrate_mode = "crf".to_string();
        options.crf = Some(26);
        let resolved = resolve(&media(), &options, &software).unwrap();
        let args = build_args(&media(), &resolved, Path::new("/tmp/out.mp4.part"));
        let flat: Vec<String> = args
            .iter()
            .map(|value| value.to_string_lossy().to_string())
            .collect();
        assert!(flat.windows(2).any(|pair| pair[0] == "-crf" && pair[1] == "26"));
        assert!(!flat.iter().any(|value| value == "-b:v"));

        let hardware = status_with("hevc_nvenc", "nvenc");
        let resolved = resolve(&media(), &options, &hardware).unwrap();
        let args = build_args(&media(), &resolved, Path::new("/tmp/out.mp4.part"));
        let flat: Vec<String> = args
            .iter()
            .map(|value| value.to_string_lossy().to_string())
            .collect();
        assert!(flat.windows(2).any(|pair| pair[0] == "-cq" && pair[1] == "26"));
        assert!(flat.windows(2).any(|pair| pair[0] == "-rc" && pair[1] == "vbr"));
    }

    #[test]
    fn rejects_crf_for_unsupported_encoder() {
        let status = status_with("hevc_mf", "mf");
        let mut options = settings();
        options.bitrate_mode = "crf".to_string();
        options.crf = Some(26);
        assert!(resolve(&media(), &options, &status).is_err());
    }

    #[test]
    fn delete_original_reuses_source_name() {
        let stem = format!("wcdc-{}", uuid::Uuid::new_v4().simple());
        let source = std::env::temp_dir().join(format!("{stem}.mp4"));
        let status = status_with("libx265", "qsv");
        let mut options = resolve(&media(), &settings(), &status).unwrap();
        options.delete_original = true;

        assert_eq!(output_path(&source, &options).unwrap(), source);

        options.container = "mkv".to_string();
        assert_eq!(
            output_path(&source, &options).unwrap(),
            source.with_extension("mkv")
        );
    }

    #[test]
    fn keeps_source_name_free_when_not_deleting() {
        let stem = format!("wcdc-{}", uuid::Uuid::new_v4().simple());
        let source = std::env::temp_dir().join(format!("{stem}.mp4"));
        let status = status_with("libx265", "qsv");
        let options = resolve(&media(), &settings(), &status).unwrap();
        let output = output_path(&source, &options).unwrap();
        assert_ne!(output, source);
        assert!(output.to_string_lossy().ends_with(".hevc.mp4"));
    }

    #[test]
    fn skips_hardware_frame_encoders() {
        let status = status_with("hevc_d3d12va", "d3d12va");
        let options = resolve(&media(), &settings(), &status).unwrap();
        assert_eq!(options.encoder, "libx265");
        assert!(!options.hardware);
    }

    #[test]
    fn no_upscale_for_preset() {
        let status = status_with("hevc_qsv", "qsv");
        let mut options = settings();
        options.resolution = "1080p".to_string();
        let resolved = resolve(&media(), &options, &status).unwrap();
        assert!(resolved.height.is_none());
        assert_eq!(resolved.resolution_label, "原始（不放大）");
    }

    #[test]
    fn builds_fps_filter_when_fixed() {
        let status = status_with("hevc_qsv", "qsv");
        let mut options = settings();
        options.encoder = "libx265".to_string();
        options.fps = Some(24.0);
        let resolved = resolve(&media(), &options, &status).unwrap();
        assert_eq!(resolved.fps, Some(24.0));
        let args = build_args(&media(), &resolved, Path::new("/tmp/out.mp4.part"));
        let flat: Vec<String> = args
            .iter()
            .map(|value| value.to_string_lossy().to_string())
            .collect();
        assert!(flat.iter().any(|value| value.contains("fps=24")));

        options.fps = Some(23.976);
        let resolved = resolve(&media(), &options, &status).unwrap();
        let args = build_args(&media(), &resolved, Path::new("/tmp/out.mp4.part"));
        let flat: Vec<String> = args
            .iter()
            .map(|value| value.to_string_lossy().to_string())
            .collect();
        assert!(flat.iter().any(|value| value.contains("fps=24000/1001")));
    }

    #[test]
    fn builds_vaapi_filters_and_args() {
        let status = status_with("hevc_vaapi", "vaapi");
        let mut options = settings();
        options.resolution = "720p".to_string();
        let resolved = resolve(&media(), &options, &status).unwrap();
        let args = build_args(&media(), &resolved, Path::new("/tmp/out.mp4.part"));
        let flat: Vec<String> = args
            .iter()
            .map(|value| value.to_string_lossy().to_string())
            .collect();
        assert!(flat.iter().any(|value| value == "-vaapi_device"));
        assert!(flat.iter().any(|value| value == "scale=-2:720:flags=lanczos,format=nv12,hwupload"));
        assert!(flat.iter().any(|value| value == "hevc_vaapi"));
    }

    #[test]
    fn qsv_uses_nv12_not_yuv420p() {
        let status = status_with("av1_qsv", "qsv");
        let options = resolve(&media(), &settings(), &status).unwrap();
        let args = build_args(&media(), &options, Path::new("/tmp/out.mp4.part"));
        let flat: Vec<String> = args
            .iter()
            .map(|value| value.to_string_lossy().to_string())
            .collect();
        assert!(flat.iter().any(|value| value == "format=nv12"));
        assert!(!flat.iter().any(|value| value == "format=yuv420p"));
    }

    #[test]
    fn cpu_thread_limit_applies_to_decoder_and_software_encoder() {
        let status = status_with("hevc_qsv", "qsv");
        let mut options = settings();
        options.encoder = "libx265".to_string();
        options.cpu_threads = Some(3);
        let resolved = resolve(&media(), &options, &status).unwrap();
        assert!(!resolved.hardware);
        assert_eq!(resolved.cpu_threads, Some(3));
        let args = build_args(&media(), &resolved, Path::new("/tmp/out.mp4.part"));
        let flat: Vec<String> = args
            .iter()
            .map(|value| value.to_string_lossy().to_string())
            .collect();
        assert_eq!(flat.iter().filter(|value| value.as_str() == "-threads").count(), 2);
        assert!(flat.windows(2).any(|pair| pair[0] == "-threads" && pair[1] == "3"));
    }

    #[test]
    fn can_switch_to_software_fallback() {
        let status = status_with("av1_qsv", "qsv");
        let options = resolve(&media(), &settings(), &status).unwrap();
        assert_eq!(options.software_fallback.as_deref(), Some("libx265"));
        let fallback = options.switch_to_software("libx265".to_string());
        assert_eq!(fallback.encoder, "libx265");
        assert!(!fallback.hardware);
        assert!(fallback.accel.is_none());
    }
}
