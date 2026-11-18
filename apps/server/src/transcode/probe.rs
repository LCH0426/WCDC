use std::collections::HashSet;
use std::env;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::codecs::{self, CodecSupport};
use super::exec;
use super::gpu::{self, GpuInfo};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathCandidate {
    pub path: String,
    pub source: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallHint {
    pub label: String,
    pub command: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HwDevice {
    pub accel: String,
    pub label: String,
    pub vendor: String,
    pub vendor_label: String,
    pub device: Option<String>,
    pub available: bool,
    pub declared: bool,
    pub verified: Option<bool>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscodeStatus {
    pub platform: String,
    pub arch: String,
    pub found: bool,
    pub path: Option<String>,
    pub source: String,
    pub ffprobe_path: Option<String>,
    pub version: Option<String>,
    pub build_config: Vec<String>,
    pub hwaccels: Vec<String>,
    pub gpus: Vec<GpuInfo>,
    pub devices: Vec<HwDevice>,
    pub codecs: Vec<CodecSupport>,
    pub candidates: Vec<PathCandidate>,
    pub install: Vec<InstallHint>,
    pub checked_at: i64,
    pub probe_ms: u64,
    pub error: Option<String>,
}

#[derive(Clone)]
struct Candidate {
    path: PathBuf,
    source: &'static str,
}

struct BinaryInfo {
    version: String,
    build_config: Vec<String>,
}

pub async fn probe(custom: Option<&str>) -> TranscodeStatus {
    let started = Instant::now();
    let candidates = collect_candidates(custom);
    let gpus = gpu::detect().await;
    let mut status = base_status(gpus);

    let mut resolved: Option<(Candidate, BinaryInfo)> = None;
    let mut resolve_error = None;

    if let Some(custom) = custom.map(str::trim).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(custom);
        let candidate = Candidate {
            path: path.clone(),
            source: "custom",
        };
        if !path.is_file() {
            resolve_error = Some(format!("自定义 ffmpeg 路径不存在或不是文件：{}", path.display()));
        } else {
            match inspect_ffmpeg(&path).await {
                Ok(info) => resolved = Some((candidate, info)),
                Err(error) => {
                    resolve_error = Some(format!("自定义 ffmpeg 无法使用：{error}"));
                }
            }
        }
    } else {
        for candidate in &candidates {
            if !candidate.path.is_file() {
                continue;
            }
            if let Ok(info) = inspect_ffmpeg(&candidate.path).await {
                resolved = Some((candidate.clone(), info));
                break;
            }
        }
    }

    status.candidates = candidates
        .iter()
        .map(|candidate| PathCandidate {
            path: candidate.path.to_string_lossy().to_string(),
            source: candidate.source.to_string(),
            exists: candidate.path.is_file(),
        })
        .collect();

    let Some((candidate, info)) = resolved else {
        status.found = false;
        status.error = resolve_error
            .or_else(|| Some("未找到 ffmpeg，请先安装或手动指定可执行文件路径".to_string()));
        status.checked_at = now_ms();
        status.probe_ms = started.elapsed().as_millis() as u64;
        return status;
    };

    status.found = true;
    status.path = Some(candidate.path.to_string_lossy().to_string());
    status.source = candidate.source.to_string();
    status.version = Some(info.version);
    status.build_config = info.build_config;

    let path = &candidate.path;
    let (hwaccels_out, encoders_out, decoders_out) = tokio::join!(
        exec::run(path, &["-hide_banner", "-hwaccels"], Duration::from_secs(10)),
        exec::run(path, &["-hide_banner", "-encoders"], Duration::from_secs(15)),
        exec::run(path, &["-hide_banner", "-decoders"], Duration::from_secs(15)),
    );

    let mut errors = Vec::new();
    let hwaccels = match hwaccels_out {
        Ok(output) => parse_hwaccels(output.text()),
        Err(error) => {
            errors.push(error);
            Vec::new()
        }
    };
    let encoders = match encoders_out {
        Ok(output) => parse_codec_list(output.text()),
        Err(error) => {
            errors.push(error);
            Vec::new()
        }
    };
    let decoders = match decoders_out {
        Ok(output) => parse_codec_list(output.text()),
        Err(error) => {
            errors.push(error);
            Vec::new()
        }
    };

    status.hwaccels = hwaccels.clone();
    status.codecs = codecs::build(&encoders, &decoders, &status.gpus);
    status.devices = build_devices(&hwaccels, &encoders, &decoders, &status.gpus);
    status.ffprobe_path = find_ffprobe(path).await;
    if !errors.is_empty() {
        status.error = Some(errors.join("；"));
    }
    status.checked_at = now_ms();
    status.probe_ms = started.elapsed().as_millis() as u64;
    status
}

/// Validate a user-supplied ffmpeg path without persisting anything.
pub async fn validate(path: &str) -> Result<(), String> {
    inspect_ffmpeg(Path::new(path)).await.map(|_| ())
}

async fn inspect_ffmpeg(path: &Path) -> Result<BinaryInfo, String> {
    let output = exec::run(
        path,
        &["-hide_banner", "-version"],
        Duration::from_secs(10),
    )
    .await?;
    let text = output.text();
    if !text.contains("ffmpeg version") {
        return Err(if output.success {
            "该文件不是 ffmpeg（输出中没有 ffmpeg version）".to_string()
        } else {
            output.error_tail()
        });
    }

    let version = text
        .lines()
        .find(|line| line.starts_with("ffmpeg version "))
        .and_then(|line| line.split_whitespace().nth(2))
        .unwrap_or("unknown")
        .to_string();
    let build_config = text
        .lines()
        .find(|line| line.trim_start().starts_with("configuration:"))
        .map(parse_build_config)
        .unwrap_or_default();

    Ok(BinaryInfo {
        version,
        build_config,
    })
}

async fn find_ffprobe(ffmpeg: &Path) -> Option<String> {
    let name = if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    let mut candidates = Vec::new();
    if let Some(parent) = ffmpeg.parent() {
        candidates.push(parent.join(name));
    }
    candidates.extend(path_candidates("ffprobe"));

    for candidate in candidates {
        if !candidate.is_file() {
            continue;
        }
        let Ok(output) = exec::run(
            &candidate,
            &["-hide_banner", "-version"],
            Duration::from_secs(8),
        )
        .await
        else {
            continue;
        };
        if output.text().contains("ffprobe version") {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

fn collect_candidates(custom: Option<&str>) -> Vec<Candidate> {
    let mut candidates = Vec::new();
    if let Some(path) = custom.map(str::trim).filter(|value| !value.is_empty()) {
        candidates.push(Candidate {
            path: PathBuf::from(path),
            source: "custom",
        });
    }
    if let Some(path) = env::var_os("WCDC_FFMPEG").or_else(|| env::var_os("FFMPEG_PATH")) {
        let path = path.to_string_lossy().trim().to_string();
        if !path.is_empty() {
            candidates.push(Candidate {
                path: PathBuf::from(path),
                source: "env",
            });
        }
    }
    for path in path_candidates("ffmpeg") {
        candidates.push(Candidate {
            path,
            source: "path",
        });
    }
    for path in common_candidates() {
        candidates.push(Candidate {
            path,
            source: "common",
        });
    }

    let mut seen = HashSet::new();
    candidates.retain(|candidate| {
        let key = if cfg!(windows) {
            candidate.path.to_string_lossy().to_ascii_lowercase()
        } else {
            candidate.path.to_string_lossy().to_string()
        };
        seen.insert(key)
    });
    candidates
}

fn path_candidates(name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let Some(path) = env::var_os("PATH") else {
        return candidates;
    };
    for directory in env::split_paths(&path) {
        for executable in executable_names(name) {
            let candidate = directory.join(executable);
            if candidate.is_file() {
                candidates.push(candidate);
                break;
            }
        }
    }
    candidates
}

fn executable_names(name: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![format!("{name}.exe"), name.to_string()]
    } else {
        vec![name.to_string()]
    }
}

fn common_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    #[cfg(windows)]
    {
        candidates.push(PathBuf::from(r"C:\ffmpeg\bin\ffmpeg.exe"));
        if let Some(local) = env::var_os("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(local)
                    .join("Microsoft")
                    .join("WinGet")
                    .join("Links")
                    .join("ffmpeg.exe"),
            );
        }
        if let Some(home) = env::var_os("USERPROFILE") {
            candidates.push(PathBuf::from(&home).join("scoop").join("shims").join("ffmpeg.exe"));
            candidates.push(
                PathBuf::from(home)
                    .join("AppData")
                    .join("Local")
                    .join("Programs")
                    .join("ffmpeg")
                    .join("bin")
                    .join("ffmpeg.exe"),
            );
        }
        if let Some(program_files) = env::var_os("ProgramFiles") {
            candidates.push(
                PathBuf::from(program_files)
                    .join("ffmpeg")
                    .join("bin")
                    .join("ffmpeg.exe"),
            );
        }
        if let Some(program_data) = env::var_os("ProgramData") {
            candidates.push(
                PathBuf::from(program_data)
                    .join("chocolatey")
                    .join("bin")
                    .join("ffmpeg.exe"),
            );
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for path in [
            "/usr/bin/ffmpeg",
            "/usr/local/bin/ffmpeg",
            "/bin/ffmpeg",
            "/snap/bin/ffmpeg",
            "/opt/ffmpeg/bin/ffmpeg",
            "/var/apps/ffmpeg/target/bin/ffmpeg",
            "/usr/lib/jellyfin-ffmpeg/ffmpeg",
        ] {
            candidates.push(PathBuf::from(path));
        }
    }

    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/ffmpeg"));
        candidates.push(PathBuf::from("/usr/local/bin/ffmpeg"));
    }

    candidates
}

fn base_status(gpus: Vec<GpuInfo>) -> TranscodeStatus {
    TranscodeStatus {
        platform: platform_name().to_string(),
        arch: env::consts::ARCH.to_string(),
        found: false,
        path: None,
        source: "none".to_string(),
        ffprobe_path: None,
        version: None,
        build_config: Vec::new(),
        hwaccels: Vec::new(),
        gpus,
        devices: Vec::new(),
        codecs: Vec::new(),
        candidates: Vec::new(),
        install: install_hints(),
        checked_at: now_ms(),
        probe_ms: 0,
        error: None,
    }
}

fn platform_name() -> &'static str {
    if cfg!(windows) {
        "Windows"
    } else if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(target_os = "linux") {
        "Linux"
    } else {
        env::consts::OS
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn parse_hwaccels(text: &str) -> Vec<String> {
    let mut methods = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("Hardware acceleration") {
            continue;
        }
        if let Some(name) = line.split_whitespace().next() {
            methods.push(name.to_string());
        }
    }
    methods
}

/// Parse `ffmpeg -encoders` / `-decoders` output, keeping video codecs only.
fn parse_codec_list(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in text.lines() {
        let line = line.trim_start();
        if !line.starts_with('V') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let flags = parts.next().unwrap_or_default();
        let Some(name) = parts.next() else {
            continue;
        };
        if flags.len() < 6 || name == "=" || name.starts_with('=') {
            continue;
        }
        names.push(name.to_string());
    }
    names
}

const FEATURE_FLAGS: &[&str] = &[
    "--enable-gpl",
    "--enable-version3",
    "--enable-nonfree",
    "--enable-libx264",
    "--enable-libx265",
    "--enable-libsvtav1",
    "--enable-libaom",
    "--enable-librav1e",
    "--enable-libvpx",
    "--enable-libdav1d",
    "--enable-libvvenc",
    "--enable-vaapi",
    "--enable-nvenc",
    "--enable-nvdec",
    "--enable-cuvid",
    "--enable-amf",
    "--enable-libvpl",
    "--enable-qsv",
    "--enable-d3d11va",
    "--enable-d3d12va",
    "--enable-dxva2",
    "--enable-mediafoundation",
    "--enable-videotoolbox",
    "--enable-vulkan",
    "--enable-libplacebo",
    "--enable-opencl",
    "--enable-libass",
    "--enable-libzimg",
    "--enable-ffnvcodec",
];

fn parse_build_config(line: &str) -> Vec<String> {
    let mut flags: Vec<String> = line
        .trim_start()
        .trim_start_matches("configuration:")
        .split_whitespace()
        .filter(|flag| FEATURE_FLAGS.contains(flag))
        .map(|flag| flag.to_string())
        .collect();
    flags.sort();
    flags.dedup();
    flags
}

fn build_devices(
    hwaccels: &[String],
    encoders: &[String],
    decoders: &[String],
    gpus: &[GpuInfo],
) -> Vec<HwDevice> {
    let mut names: Vec<String> = hwaccels.to_vec();
    for codec in encoders.iter().chain(decoders.iter()) {
        if let Some((accel, _)) = codecs::hardware_kind(codec) {
            if !names.iter().any(|name| name == accel) {
                names.push(accel.to_string());
            }
        }
    }

    let mut seen = HashSet::new();
    names.retain(|name| seen.insert(name.clone()));
    names.sort_by_key(|name| accel_order(name));

    let render = first_render_device(gpus);
    names
        .iter()
        .map(|accel| {
            let vendor = device_vendor(accel, gpus);
            let (available, device, note) = availability(accel, gpus, render.as_deref());
            let note = if matches!(accel.as_str(), "d3d12va" | "vulkan" | "opencl") {
                Some(
                    "当前版本未接入硬件帧上传，不能直接用于本页转码；仅作为能力信息展示"
                        .to_string(),
                )
            } else {
                note
            };
            HwDevice {
                accel: accel.clone(),
                label: accel_label(accel).to_string(),
                vendor: vendor.to_string(),
                vendor_label: gpu::vendor_label(vendor).to_string(),
                device,
                available,
                declared: true,
                verified: None,
                note,
            }
        })
        .collect()
}

fn accel_order(accel: &str) -> usize {
    const ORDER: &[&str] = &[
        "vaapi",
        "qsv",
        "nvenc",
        "nvdec",
        "cuda",
        "amf",
        "mf",
        "d3d11va",
        "dxva2",
        "d3d12va",
        "videotoolbox",
        "vulkan",
        "opencl",
        "vdpau",
        "drm",
        "rkmpp",
        "v4l2m2m",
        "mediacodec",
    ];
    ORDER
        .iter()
        .position(|candidate| *candidate == accel)
        .unwrap_or(ORDER.len())
}

fn device_vendor(accel: &str, gpus: &[GpuInfo]) -> &'static str {
    match accel {
        "vaapi" => {
            if gpus.iter().any(|gpu| gpu.vendor == "intel") {
                "intel"
            } else if gpus.iter().any(|gpu| gpu.vendor == "amd") {
                "amd"
            } else {
                "generic"
            }
        }
        "qsv" => "intel",
        "nvenc" | "nvdec" | "cuda" => "nvidia",
        "amf" => "amd",
        "videotoolbox" => "apple",
        "mf" | "d3d11va" | "dxva2" | "d3d12va" => "microsoft",
        "rkmpp" | "v4l2m2m" => "arm",
        "mediacodec" => "android",
        _ => "generic",
    }
}

fn availability(
    accel: &str,
    gpus: &[GpuInfo],
    render: Option<&str>,
) -> (bool, Option<String>, Option<String>) {
    match accel {
        "vaapi" => match render {
            Some(device) => (true, Some(device.to_string()), None),
            None => (
                false,
                None,
                Some("未发现 /dev/dri/renderD* 设备".to_string()),
            ),
        },
        "qsv" => {
            let intel = gpus.is_empty() || gpus.iter().any(|gpu| gpu.vendor == "intel");
            if cfg!(windows) {
                (
                    intel,
                    None,
                    Some(if intel {
                        "Windows 下由 Intel 核显驱动提供".to_string()
                    } else {
                        "未检测到 Intel 显卡".to_string()
                    }),
                )
            } else if let Some(device) = render {
                (
                    intel,
                    Some(device.to_string()),
                    if intel {
                        None
                    } else {
                        Some("未检测到 Intel 显卡".to_string())
                    },
                )
            } else {
                (
                    false,
                    None,
                    Some("需要 /dev/dri 与 Intel 核显".to_string()),
                )
            }
        }
        "cuda" | "nvdec" | "nvenc" => {
            let nvidia = gpus.is_empty() || gpus.iter().any(|gpu| gpu.vendor == "nvidia");
            (
                nvidia,
                None,
                if gpus.is_empty() {
                    Some("未枚举到显卡，无法确认".to_string())
                } else if nvidia {
                    None
                } else {
                    Some("未检测到 NVIDIA 显卡".to_string())
                },
            )
        }
        "amf" => {
            let amd = gpus.is_empty() || gpus.iter().any(|gpu| gpu.vendor == "amd");
            (
                amd,
                None,
                if gpus.is_empty() {
                    Some("未枚举到显卡，无法确认".to_string())
                } else if amd {
                    None
                } else {
                    Some("未检测到 AMD 显卡".to_string())
                },
            )
        }
        "videotoolbox" => (
            cfg!(target_os = "macos"),
            None,
            if cfg!(target_os = "macos") {
                None
            } else {
                Some("仅 macOS 可用".to_string())
            },
        ),
        "mf" | "d3d11va" | "dxva2" | "d3d12va" => (
            cfg!(windows),
            None,
            if cfg!(windows) {
                None
            } else {
                Some("仅 Windows 可用".to_string())
            },
        ),
        "rkmpp" => {
            let device = ["/dev/mpp_service", "/dev/rga"]
                .iter()
                .find(|path| Path::new(path).exists())
                .map(|path| path.to_string());
            let supported = device.is_some()
                || gpus
                    .iter()
                    .any(|gpu| matches!(gpu.vendor.as_str(), "rockchip" | "arm"));
            (
                supported,
                device,
                if supported {
                    None
                } else {
                    Some("未发现 Rockchip MPP 设备".to_string())
                },
            )
        }
        "v4l2m2m" => {
            let device = scan_video_devices().into_iter().next();
            (
                device.is_some(),
                device,
                if cfg!(unix) {
                    Some("依赖内核 V4L2 M2M 驱动".to_string())
                } else {
                    Some("仅 Linux 可用".to_string())
                },
            )
        }
        "mediacodec" => (
            cfg!(target_os = "android"),
            None,
            Some("仅 Android 可用".to_string()),
        ),
        "vdpau" => {
            let vendor = gpus
                .iter()
                .any(|gpu| matches!(gpu.vendor.as_str(), "nvidia" | "amd"));
            (cfg!(unix) && vendor, None, None)
        }
        "drm" => (
            render.is_some(),
            render.map(str::to_string),
            None,
        ),
        "vulkan" | "opencl" => (
            true,
            None,
            Some("具体设备由驱动决定".to_string()),
        ),
        _ => (true, None, Some("由 ffmpeg 声明".to_string())),
    }
}

fn first_render_device(gpus: &[GpuInfo]) -> Option<String> {
    gpus.iter()
        .flat_map(|gpu| gpu.render_devices.iter().cloned())
        .next()
        .or_else(|| scan_render_devices().into_iter().next())
}

fn scan_render_devices() -> Vec<String> {
    let mut devices = Vec::new();
    if let Ok(entries) = std::fs::read_dir("/dev/dri") {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("renderD") {
                devices.push(format!("/dev/dri/{name}"));
            }
        }
    }
    devices.sort();
    devices
}

fn scan_video_devices() -> Vec<String> {
    let mut devices = Vec::new();
    if let Ok(entries) = std::fs::read_dir("/dev") {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(number) = name.strip_prefix("video") {
                if number.chars().all(|ch| ch.is_ascii_digit()) {
                    devices.push(format!("/dev/{name}"));
                }
            }
        }
    }
    devices.sort();
    devices
}

fn accel_label(accel: &str) -> &'static str {
    match accel {
        "vaapi" => "VAAPI",
        "qsv" => "Intel Quick Sync (QSV)",
        "cuda" => "CUDA / NVDEC",
        "nvenc" => "NVENC",
        "nvdec" => "NVDEC",
        "amf" => "AMD AMF",
        "videotoolbox" => "VideoToolbox",
        "mf" => "Media Foundation",
        "d3d11va" => "D3D11VA",
        "dxva2" => "DXVA2",
        "d3d12va" => "D3D12VA",
        "vulkan" => "Vulkan",
        "opencl" => "OpenCL",
        "vdpau" => "VDPAU",
        "drm" => "DRM",
        "rkmpp" => "Rockchip MPP",
        "v4l2m2m" => "V4L2 M2M",
        "mediacodec" => "MediaCodec",
        _ => "其他",
    }
}

fn install_hints() -> Vec<InstallHint> {
    let mut hints = Vec::new();

    #[cfg(windows)]
    {
        hints.push(InstallHint {
            label: "winget".to_string(),
            command: "winget install --id Gyan.FFmpeg -e".to_string(),
            note: None,
        });
        hints.push(InstallHint {
            label: "Scoop".to_string(),
            command: "scoop install ffmpeg".to_string(),
            note: None,
        });
        hints.push(InstallHint {
            label: "Chocolatey".to_string(),
            command: "choco install ffmpeg".to_string(),
            note: None,
        });
        hints.push(InstallHint {
            label: "手动安装".to_string(),
            command: String::new(),
            note: Some(
                "从 gyan.dev 下载带 shared/full 的构建，解压后把 bin 目录加入 PATH，或在下方手动填写 ffmpeg.exe 的绝对路径。"
                    .to_string(),
            ),
        });
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        hints.push(InstallHint {
            label: "Debian / Ubuntu".to_string(),
            command: "sudo apt update && sudo apt install -y ffmpeg".to_string(),
            note: None,
        });
        hints.push(InstallHint {
            label: "Fedora".to_string(),
            command: "sudo dnf install -y ffmpeg".to_string(),
            note: None,
        });
        hints.push(InstallHint {
            label: "Arch".to_string(),
            command: "sudo pacman -S ffmpeg".to_string(),
            note: None,
        });
        hints.push(InstallHint {
            label: "硬件加速".to_string(),
            command: String::new(),
            note: Some(
                "Intel 核显需要 intel-media-va-driver（或 i965-va-driver），AMD 需要 mesa-va-drivers，NVIDIA 需要专有驱动。飞牛/群晖等 NAS 上的应用运行用户还需要 video、render 组权限，并能访问 /dev/dri。"
                    .to_string(),
            ),
        });
    }

    #[cfg(target_os = "macos")]
    {
        hints.push(InstallHint {
            label: "Homebrew".to_string(),
            command: "brew install ffmpeg".to_string(),
            note: None,
        });
    }

    if hints.is_empty() {
        hints.push(InstallHint {
            label: "安装 ffmpeg".to_string(),
            command: String::new(),
            note: Some("请安装 ffmpeg 并确保它位于 PATH 中，或手动填写可执行文件路径。".to_string()),
        });
    }
    hints
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ffmpeg_version_and_flags() {
        let text = "ffmpeg version 7.1.1-full_build Copyright (c) 2000-2024\nconfiguration: --enable-gpl --enable-libx264 --enable-nvenc --disable-foo\n";
        let info = parse_version_for_test(text);
        assert_eq!(info.0.as_deref(), Some("7.1.1-full_build"));
        assert_eq!(
            info.1,
            vec![
                "--enable-gpl".to_string(),
                "--enable-libx264".to_string(),
                "--enable-nvenc".to_string()
            ]
        );
    }

    fn parse_version_for_test(text: &str) -> (Option<String>, Vec<String>) {
        let version = text
            .lines()
            .find(|line| line.starts_with("ffmpeg version "))
            .and_then(|line| line.split_whitespace().nth(2))
            .map(str::to_string);
        let flags = text
            .lines()
            .find(|line| line.trim_start().starts_with("configuration:"))
            .map(parse_build_config)
            .unwrap_or_default();
        (version, flags)
    }

    #[test]
    fn parses_codec_lists() {
        let text = "Encoders:\n V..... = Video\n ------\n V....D h264_vaapi           H.264 (VAAPI)\n V....D libx264              libx264\n A....D aac                  AAC\n";
        assert_eq!(parse_codec_list(text), vec!["h264_vaapi", "libx264"]);
    }

    #[test]
    fn parses_hwaccels() {
        let text = "Hardware acceleration methods:\nvaapi\nqsv\ncuda\n";
        assert_eq!(parse_hwaccels(text), vec!["vaapi", "qsv", "cuda"]);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn builds_vaapi_device_on_linux() {
        let gpus = vec![gpu::GpuInfo {
            vendor: "intel".to_string(),
            vendor_label: "Intel".to_string(),
            name: "iGPU".to_string(),
            driver: None,
            bus: None,
            render_devices: vec!["/dev/dri/renderD128".to_string()],
        }];
        let devices = build_devices(
            &["vaapi".to_string()],
            &["h264_vaapi".to_string()],
            &["h264".to_string()],
            &gpus,
        );
        let vaapi = devices.iter().find(|device| device.accel == "vaapi").unwrap();
        assert!(vaapi.available);
        assert_eq!(vaapi.device.as_deref(), Some("/dev/dri/renderD128"));
        assert_eq!(vaapi.vendor, "intel");
    }
}
