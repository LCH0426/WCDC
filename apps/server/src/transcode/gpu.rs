use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::exec;

#[cfg(all(unix, not(target_os = "macos")))]
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub vendor: String,
    pub vendor_label: String,
    pub name: String,
    pub driver: Option<String>,
    pub bus: Option<String>,
    pub render_devices: Vec<String>,
}

/// Enumerate GPUs on the machine running the server. Failures are non-fatal:
/// an empty list simply means the UI cannot map accelerators to a vendor.
pub async fn detect() -> Vec<GpuInfo> {
    #[cfg(windows)]
    {
        detect_windows().await
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        detect_linux().await
    }
    #[cfg(target_os = "macos")]
    {
        detect_macos().await
    }
    #[cfg(not(any(windows, unix)))]
    {
        Vec::new()
    }
}

pub fn vendor_label(vendor: &str) -> &'static str {
    match vendor {
        "intel" => "Intel",
        "amd" => "AMD",
        "nvidia" => "NVIDIA",
        "apple" => "Apple",
        "arm" => "ARM",
        "rockchip" => "Rockchip",
        "microsoft" => "Windows",
        "generic" => "通用",
        _ => "其他",
    }
}

// Used on Windows/macOS and by the cross-platform tests; Linux matches PCI ids.
#[allow(dead_code)]
pub fn vendor_from_name(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.contains("nvidia") {
        "nvidia"
    } else if lower.contains("amd")
        || lower.contains("radeon")
        || lower.contains("advanced micro devices")
    {
        "amd"
    } else if lower.contains("intel") {
        "intel"
    } else if lower.contains("apple") {
        "apple"
    } else if lower.contains("rockchip") {
        "rockchip"
    } else if lower.contains("arm") || lower.contains("mali") || lower.contains("adreno") {
        "arm"
    } else {
        "other"
    }
}

// Used by Linux GPU detection and by the cross-platform tests.
#[allow(dead_code)]
fn vendor_from_pci(id: &str) -> &'static str {
    match id.trim().to_ascii_lowercase().trim_start_matches("0x") {
        "8086" => "intel",
        "1002" => "amd",
        "10de" => "nvidia",
        "106b" => "apple",
        "13b5" => "arm",
        _ => "other",
    }
}

fn gpu(vendor: &str, name: String, driver: Option<String>, bus: Option<String>, render_devices: Vec<String>) -> GpuInfo {
    GpuInfo {
        vendor: vendor.to_string(),
        vendor_label: vendor_label(vendor).to_string(),
        name,
        driver,
        bus,
        render_devices,
    }
}

#[cfg(windows)]
async fn detect_windows() -> Vec<GpuInfo> {
    const SCRIPT: &str = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,PNPDeviceID | ConvertTo-Json -Compress";
    let mut text = None;
    for program in ["powershell.exe", "pwsh.exe"] {
        if let Ok(output) = exec::run(
            Path::new(program),
            &["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
            Duration::from_secs(8),
        )
        .await
        {
            if output.success && !output.text().trim().is_empty() {
                text = Some(output.text().to_string());
                break;
            }
        }
    }
    let Some(text) = text else {
        return Vec::new();
    };
    parse_windows_gpus(&text)
}

#[cfg(windows)]
fn parse_windows_gpus(text: &str) -> Vec<GpuInfo> {
    use serde_json::Value;

    let clean = text.trim().trim_start_matches('\u{feff}');
    let Ok(value) = serde_json::from_str::<Value>(clean) else {
        return Vec::new();
    };
    let items: Vec<&Value> = match &value {
        Value::Array(entries) => entries.iter().collect(),
        Value::Object(_) => vec![&value],
        _ => Vec::new(),
    };
    items
        .into_iter()
        .filter_map(|item| {
            let name = item.get("Name")?.as_str()?.trim().to_string();
            if name.is_empty() || is_virtual_gpu(&name) {
                return None;
            }
            let pnp = item
                .get("PNPDeviceID")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let driver = item
                .get("DriverVersion")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .map(|value| value.trim().to_string());
            let vendor = if pnp.contains("VEN_10DE") {
                "nvidia"
            } else if pnp.contains("VEN_1002") {
                "amd"
            } else if pnp.contains("VEN_8086") {
                "intel"
            } else {
                vendor_from_name(&name)
            };
            Some(gpu(vendor, name, driver, None, Vec::new()))
        })
        .collect()
}

#[cfg(windows)]
fn is_virtual_gpu(name: &str) -> bool {
    const SKIP: &[&str] = &[
        "Microsoft Basic",
        "Microsoft Remote",
        "Basic Render",
        "Remote Display",
        "Parsec",
        "Citrix",
        "VMware",
        "VirtualBox",
        "Hyper-V",
        "Virtual Display",
        "MuMu",
        "GameViewer",
        "Sunshine",
        "ToDesk",
    ];
    SKIP.iter().any(|needle| name.contains(needle))
}

#[cfg(all(unix, not(target_os = "macos")))]
async fn detect_linux() -> Vec<GpuInfo> {
    let lspci = lspci_names().await;
    let mut gpus = Vec::new();

    if let Ok(entries) = std::fs::read_dir("/sys/class/drm") {
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if !file_name.starts_with("card") || file_name.contains('-') {
                continue;
            }
            let device_dir = entry.path().join("device");
            if !device_dir.exists() {
                continue;
            }

            let vendor_id = read_trim(device_dir.join("vendor")).unwrap_or_default();
            let vendor = vendor_from_pci(&vendor_id);
            let uevent = std::fs::read_to_string(device_dir.join("uevent")).unwrap_or_default();
            let slot = uevent
                .lines()
                .find_map(|line| line.strip_prefix("PCI_SLOT_NAME="))
                .map(str::trim)
                .unwrap_or_default()
                .to_string();
            let driver = std::fs::read_link(device_dir.join("driver"))
                .ok()
                .and_then(|target| target.file_name().map(|value| value.to_string_lossy().to_string()));

            let name = lspci.get(&normalize_slot(&slot)).cloned().unwrap_or_else(|| {
                let suffix = driver
                    .as_deref()
                    .map(|driver| format!("（{driver}）"))
                    .unwrap_or_default();
                format!("{} 显卡{suffix}", vendor_label(vendor))
            });

            let render_devices = render_device_for(&device_dir).into_iter().collect();
            gpus.push(gpu(
                vendor,
                name,
                driver,
                if slot.is_empty() { None } else { Some(slot) },
                render_devices,
            ));
        }
    }

    if gpus.is_empty() {
        if let Some(model) = read_trim("/proc/device-tree/model") {
            let vendor = if model.to_ascii_lowercase().contains("rockchip") {
                "rockchip"
            } else {
                "arm"
            };
            gpus.push(gpu(vendor, model, None, None, scan_render_devices()));
        }
    }

    enrich_nvidia(&mut gpus).await;
    dedup(gpus)
}

#[cfg(all(unix, not(target_os = "macos")))]
async fn lspci_names() -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(output) = exec::run(Path::new("lspci"), &["-nn"], Duration::from_secs(4)).await else {
        return map;
    };
    for line in output.text().lines() {
        let Some((slot, rest)) = line.split_once(' ') else {
            continue;
        };
        if !(rest.contains("VGA compatible controller")
            || rest.contains("3D controller")
            || rest.contains("Display controller"))
        {
            continue;
        }
        let name = rest
            .split_once("]: ")
            .map(|(_, name)| name)
            .unwrap_or(rest)
            .trim();
        if !name.is_empty() {
            map.insert(normalize_slot(slot), name.to_string());
        }
    }
    map
}

#[cfg(all(unix, not(target_os = "macos")))]
fn normalize_slot(slot: &str) -> String {
    let parts: Vec<&str> = slot.split(':').collect();
    if parts.len() == 3 {
        format!("{}:{}", parts[1], parts[2])
    } else {
        slot.to_string()
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn render_device_for(device_dir: &Path) -> Option<String> {
    let target = std::fs::canonicalize(device_dir).ok()?;
    let entries = std::fs::read_dir("/sys/class/drm").ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("renderD") {
            continue;
        }
        if let Ok(device) = std::fs::canonicalize(entry.path().join("device")) {
            if device == target {
                return Some(format!("/dev/dri/{name}"));
            }
        }
    }
    None
}

#[cfg(all(unix, not(target_os = "macos")))]
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

#[cfg(all(unix, not(target_os = "macos")))]
async fn enrich_nvidia(gpus: &mut [GpuInfo]) {
    if !gpus.iter().any(|gpu| gpu.vendor == "nvidia") {
        return;
    }
    let Ok(output) = exec::run(
        Path::new("nvidia-smi"),
        &[
            "--query-gpu=name,driver_version",
            "--format=csv,noheader",
        ],
        Duration::from_secs(4),
    )
    .await
    else {
        return;
    };
    let rows: Vec<(String, String)> = output
        .text()
        .lines()
        .filter_map(|line| {
            let (name, driver) = line.split_once(',')?;
            Some((name.trim().to_string(), driver.trim().to_string()))
        })
        .collect();
    let mut index = 0;
    for gpu in gpus.iter_mut().filter(|gpu| gpu.vendor == "nvidia") {
        if let Some((name, driver)) = rows.get(index) {
            if !name.is_empty() {
                gpu.name = name.clone();
            }
            if !driver.is_empty() {
                gpu.driver = Some(driver.clone());
            }
        }
        index += 1;
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn read_trim(path: impl AsRef<Path>) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let text = String::from_utf8_lossy(&bytes).replace('\0', "");
    let text = text.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn dedup(gpus: Vec<GpuInfo>) -> Vec<GpuInfo> {
    let mut seen = HashSet::new();
    gpus
        .into_iter()
        .filter(|gpu| {
            seen.insert(format!(
                "{}|{}|{}",
                gpu.vendor,
                gpu.bus.clone().unwrap_or_default(),
                gpu.name
            ))
        })
        .collect()
}

#[cfg(target_os = "macos")]
async fn detect_macos() -> Vec<GpuInfo> {
    use serde_json::Value;

    let Ok(output) = exec::run(
        Path::new("system_profiler"),
        &["SPDisplaysDataType", "-json"],
        Duration::from_secs(8),
    )
    .await
    else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(output.text()) else {
        return Vec::new();
    };
    value
        .get("SPDisplaysDataType")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let name = item.get("sppci_model")?.as_str()?.trim().to_string();
                    if name.is_empty() {
                        return None;
                    }
                    let vendor = vendor_from_name(&name);
                    Some(gpu(vendor, name, None, None, Vec::new()))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_pci_vendors() {
        assert_eq!(vendor_from_pci("0x8086"), "intel");
        assert_eq!(vendor_from_pci("0x10de"), "nvidia");
        assert_eq!(vendor_from_pci("0x1002"), "amd");
        assert_eq!(vendor_from_pci("0x1234"), "other");
    }

    #[test]
    fn maps_names() {
        assert_eq!(vendor_from_name("NVIDIA GeForce RTX 4060"), "nvidia");
        assert_eq!(vendor_from_name("AMD Radeon RX 7800 XT"), "amd");
        assert_eq!(vendor_from_name("Intel(R) UHD Graphics"), "intel");
        assert_eq!(vendor_from_name("Apple M2"), "apple");
    }
}
