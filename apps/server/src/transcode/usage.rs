use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::Mutex;

use super::exec;
#[cfg(all(unix, not(target_os = "macos")))]
use super::gpu;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuUsage {
    pub index: u32,
    pub name: String,
    pub vendor: String,
    pub utilization: Option<f64>,
    pub encoder: Option<f64>,
    pub decoder: Option<f64>,
    pub memory_used_bytes: Option<u64>,
    pub memory_total_bytes: Option<u64>,
    pub temperature_c: Option<f64>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscodeStats {
    pub cpu_usage_percent: f32,
    pub memory_used_bytes: u64,
    pub memory_total_bytes: u64,
    pub gpus: Vec<GpuUsage>,
    pub sampled_at: i64,
}

static CACHE: OnceLock<Mutex<Option<(Instant, Vec<GpuUsage>)>>> = OnceLock::new();

/// Sample GPU utilization. Results are cached briefly because the Windows
/// performance-counter path and nvidia-smi are relatively expensive.
pub async fn sample() -> Vec<GpuUsage> {
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock().await;
    if let Some((at, value)) = guard.as_ref() {
        if at.elapsed() < Duration::from_millis(1500) {
            return value.clone();
        }
    }
    let value = sample_inner().await;
    *guard = Some((Instant::now(), value.clone()));
    value
}

async fn sample_inner() -> Vec<GpuUsage> {
    let mut gpus = sample_nvidia().await;

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let has_nvidia = !gpus.is_empty();
        gpus.extend(sample_linux_sysfs(has_nvidia));
    }

    #[cfg(windows)]
    {
        if gpus.is_empty() {
            gpus.extend(sample_windows_counters().await);
        }
    }

    gpus
}

async fn sample_nvidia() -> Vec<GpuUsage> {
    let full = [
        "--query-gpu=index,name,utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total,temperature.gpu",
        "--format=csv,noheader,nounits",
    ];
    let basic = [
        "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu",
        "--format=csv,noheader,nounits",
    ];

    for (args, with_engines) in [(full.as_slice(), true), (basic.as_slice(), false)] {
        let Ok(output) = exec::run(
            Path::new("nvidia-smi"),
            args,
            Duration::from_secs(4),
        )
        .await
        else {
            continue;
        };
        if !output.success {
            continue;
        }
        let parsed = parse_nvidia(&output.text(), with_engines);
        if !parsed.is_empty() {
            return parsed;
        }
    }
    Vec::new()
}

fn parse_nvidia(text: &str, with_engines: bool) -> Vec<GpuUsage> {
    let mut gpus = Vec::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let fields: Vec<&str> = line.split(',').map(str::trim).collect();
        if fields.len() < 3 {
            continue;
        }
        let index = fields[0].parse::<u32>().unwrap_or(gpus.len() as u32);
        let name = fields[1].to_string();
        let utilization = parse_number(fields.get(2).copied());
        let (encoder, decoder, memory_index) = if with_engines {
            (
                parse_number(fields.get(3).copied()),
                parse_number(fields.get(4).copied()),
                5,
            )
        } else {
            (None, None, 3)
        };
        let memory_used = parse_number(fields.get(memory_index).copied())
            .map(|mib| (mib * 1024.0 * 1024.0) as u64);
        let memory_total = parse_number(fields.get(memory_index + 1).copied())
            .map(|mib| (mib * 1024.0 * 1024.0) as u64);
        let temperature = parse_number(fields.get(memory_index + 2).copied());
        gpus.push(GpuUsage {
            index,
            name,
            vendor: "nvidia".to_string(),
            utilization,
            encoder,
            decoder,
            memory_used_bytes: memory_used,
            memory_total_bytes: memory_total,
            temperature_c: temperature,
            source: "nvidia-smi".to_string(),
        });
    }
    gpus
}

#[cfg(all(unix, not(target_os = "macos")))]
fn sample_linux_sysfs(skip_nvidia: bool) -> Vec<GpuUsage> {
    let mut gpus = Vec::new();
    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else {
        return gpus;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("card") || name.contains('-') {
            continue;
        }
        let device = entry.path().join("device");
        if !device.exists() {
            continue;
        }
        let vendor_id = std::fs::read_to_string(device.join("vendor"))
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let vendor = match vendor_id.trim_start_matches("0x") {
            "8086" => "intel",
            "1002" => "amd",
            "10de" => "nvidia",
            _ => "other",
        };
        if skip_nvidia && vendor == "nvidia" {
            continue;
        }
        let utilization = read_number(device.join("gpu_busy_percent"));
        let memory_used = read_number(device.join("mem_info_vram_used")).map(|value| value as u64);
        let memory_total = read_number(device.join("mem_info_vram_total")).map(|value| value as u64);
        let temperature = read_temperature(&device);
        let index = name
            .trim_start_matches("card")
            .parse::<u32>()
            .unwrap_or(gpus.len() as u32);
        let label = if vendor == "other" {
            format!("GPU {index}")
        } else {
            format!("{} GPU", gpu::vendor_label(vendor))
        };
        gpus.push(GpuUsage {
            index,
            name: label,
            vendor: vendor.to_string(),
            utilization,
            encoder: None,
            decoder: None,
            memory_used_bytes: memory_used,
            memory_total_bytes: memory_total,
            temperature_c: temperature,
            source: "sysfs".to_string(),
        });
    }
    gpus
}

#[cfg(all(unix, not(target_os = "macos")))]
fn read_temperature(device: &Path) -> Option<f64> {
    let hwmon = device.join("hwmon");
    let entries = std::fs::read_dir(hwmon).ok()?;
    for entry in entries.flatten() {
        if let Some(value) = read_number(entry.path().join("temp1_input")) {
            return Some(value / 1000.0);
        }
    }
    None
}

#[cfg(all(unix, not(target_os = "macos")))]
fn read_number(path: impl AsRef<Path>) -> Option<f64> {
    let text = std::fs::read_to_string(path).ok()?;
    text.trim().parse::<f64>().ok()
}

#[cfg(windows)]
async fn sample_windows_counters() -> Vec<GpuUsage> {
    const SCRIPT: &str = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $rows = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue; if ($rows) { $rows | Where-Object { $_.Name -match 'engtype_(3D|VideoEncode|VideoDecode|Compute|Copy)' } | ForEach-Object { [pscustomobject]@{ Name=$_.Name; Utilization=[double]$_.UtilizationPercentage } } | ConvertTo-Json -Compress }";
    let mut text = None;
    for program in ["powershell.exe", "pwsh.exe"] {
        if let Ok(output) = exec::run(
            Path::new(program),
            &["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
            Duration::from_secs(6),
        )
        .await
        {
            if output.success {
                let value = output.text().trim().to_string();
                if !value.is_empty() {
                    text = Some(value);
                    break;
                }
            }
        }
    }
    let Some(text) = text else {
        return Vec::new();
    };
    parse_windows_counters(&text)
}

#[cfg(windows)]
fn parse_windows_counters(text: &str) -> Vec<GpuUsage> {
    use serde_json::Value;

    let clean = text.trim().trim_start_matches('\u{feff}');
    let Ok(value) = serde_json::from_str::<Value>(clean) else {
        return Vec::new();
    };
    let items: Vec<&Value> = match &value {
        Value::Array(items) => items.iter().collect(),
        Value::Object(_) => vec![&value],
        _ => return Vec::new(),
    };
    let mut encode = 0.0;
    let mut decode = 0.0;
    let mut threed = 0.0;
    for item in items {
        let Some(name) = item.get("Name").and_then(|value| value.as_str()) else {
            continue;
        };
        let utilization = item
            .get("Utilization")
            .and_then(|value| value.as_f64())
            .unwrap_or(0.0);
        let lower = name.to_ascii_lowercase();
        if lower.contains("engtype_videoencode") {
            encode += utilization;
        } else if lower.contains("engtype_videodecode") {
            decode += utilization;
        } else if lower.contains("engtype_3d") {
            threed += utilization;
        }
    }
    if encode == 0.0 && decode == 0.0 && threed == 0.0 {
        return Vec::new();
    }
    let encode = encode.clamp(0.0, 100.0);
    let decode = decode.clamp(0.0, 100.0);
    let threed = threed.clamp(0.0, 100.0);
    vec![GpuUsage {
        index: 0,
        name: "GPU".to_string(),
        vendor: "generic".to_string(),
        utilization: Some(threed.max(encode).max(decode)),
        encoder: Some(encode),
        decoder: Some(decode),
        memory_used_bytes: None,
        memory_total_bytes: None,
        temperature_c: None,
        source: "windows-cim".to_string(),
    }]
}

fn parse_number(value: Option<&str>) -> Option<f64> {
    let value = value?.trim();
    if value.is_empty()
        || value.eq_ignore_ascii_case("n/a")
        || value.eq_ignore_ascii_case("[n/a]")
        || value.contains("not supported")
    {
        return None;
    }
    value.parse::<f64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nvidia_output() {
        let text = "0, NVIDIA GeForce RTX 4060, 42, 12, 3, 1536, 8188, 55\n";
        let gpus = parse_nvidia(text, true);
        assert_eq!(gpus.len(), 1);
        assert_eq!(gpus[0].utilization, Some(42.0));
        assert_eq!(gpus[0].encoder, Some(12.0));
        assert_eq!(gpus[0].memory_total_bytes, Some(8188 * 1024 * 1024));
    }

    #[test]
    fn ignores_unsupported_values() {
        assert_eq!(parse_number(Some("[N/A]")), None);
        assert_eq!(parse_number(Some("Not Supported")), None);
        assert_eq!(parse_number(Some("12.5")), Some(12.5));
    }
}
