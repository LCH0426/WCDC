use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use quark_protocol::QrLoginConfig;

/// A storage volume exposed by the web server. Downloads may only be written
/// below one of these roots; the browser never gets to pick an arbitrary path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeConfig {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone)]
pub struct WebConfig {
    pub bind: String,
    pub data_dir: PathBuf,
    pub static_dir: Option<PathBuf>,
    pub gateway_prefix: Option<String>,
    pub unix_socket: Option<PathBuf>,
    pub fnos_mode: bool,
    pub allowed_paths: Vec<PathBuf>,
    pub volumes: Vec<VolumeConfig>,
    pub dev_origins: Vec<String>,
    pub api_base: String,
    pub pc_api_base: String,
    pub account_base: String,
    pub oss_base_override: Option<String>,
    pub qr_login: QrLoginConfig,
}

impl WebConfig {
    pub fn from_env() -> Result<Self> {
        let data_dir = env_path("WCDC_DATA_DIR")
            .unwrap_or_else(|| dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("wcdc"));
        std::fs::create_dir_all(&data_dir)
            .with_context(|| format!("无法创建数据目录 {}", data_dir.display()))?;

        // Optional disk override for development; normally the frontend is embedded.
        let static_dir = env_path("WCDC_STATIC_DIR");
        let gateway_prefix = std::env::var("WCDC_GATEWAY_PREFIX")
            .ok()
            .and_then(|value| normalize_gateway_prefix(&value));
        let unix_socket = env_path("WCDC_UNIX_SOCKET");
        let fnos_mode = std::env::var("WCDC_FNOS_MODE")
            .ok()
            .map(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "on"))
            .unwrap_or(false);
        let allowed_paths = std::env::var("WCDC_ALLOWED_PATHS")
            .ok()
            .map(|value| parse_allowed_paths(&value))
            .unwrap_or_default();
        let volumes = load_volumes(&data_dir)?;
        let dev_origins = std::env::var("WCDC_DEV_ORIGIN")
            .ok()
            .map(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| {
                vec![
                    "http://localhost:5173".to_string(),
                    "http://127.0.0.1:5173".to_string(),
                ]
            });

        let mut qr_login = QrLoginConfig::default();
        if let Ok(value) = std::env::var("WCDC_QR_TOKEN_URL") {
            qr_login.token_url = value;
        }
        if let Ok(value) = std::env::var("WCDC_QR_POLL_URL") {
            qr_login.poll_url = value;
        }
        if let Ok(value) = std::env::var("WCDC_QR_ACCOUNT_URL") {
            qr_login.account_info_url = value;
        }
        if let Ok(value) = std::env::var("WCDC_QR_SCAN_URL") {
            qr_login.scan_url = value;
        }

        Ok(Self {
            bind: std::env::var("WCDC_BIND").unwrap_or_else(|_| "127.0.0.1:8787".to_string()),
            data_dir,
            static_dir,
            gateway_prefix,
            unix_socket,
            fnos_mode,
            allowed_paths,
            volumes,
            dev_origins,
            api_base: std::env::var("WCDC_API_BASE")
                .unwrap_or_else(|_| "https://drive.quark.cn/1/clouddrive".to_string()),
            pc_api_base: std::env::var("WCDC_PC_API_BASE")
                .unwrap_or_else(|_| "https://drive-pc.quark.cn/1/clouddrive".to_string()),
            account_base: std::env::var("WCDC_ACCOUNT_BASE")
                .unwrap_or_else(|_| "https://pan.quark.cn".to_string()),
            oss_base_override: std::env::var("WCDC_OSS_BASE")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            qr_login,
        })
    }

    pub fn default_volume(&self) -> Option<&VolumeConfig> {
        self.volumes.first()
    }

    pub fn volume(&self, id: &str) -> Option<&VolumeConfig> {
        self.volumes.iter().find(|volume| volume.id == id)
    }
}

fn parse_allowed_paths(value: &str) -> Vec<PathBuf> {
    let separator = if cfg!(windows) { ';' } else { ':' };
    let mut seen = std::collections::HashSet::new();
    value
        .split(separator)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .filter(|path| seen.insert(path.to_string_lossy().to_string()))
        .collect()
}

fn normalize_gateway_prefix(value: &str) -> Option<String> {
    let value = value.trim().trim_end_matches('/');
    if value.is_empty() || value == "/" {
        return None;
    }
    let value = if value.starts_with('/') {
        value.to_string()
    } else {
        format!("/{value}")
    };
    Some(value)
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

fn load_volumes(data_dir: &Path) -> Result<Vec<VolumeConfig>> {
    if let Ok(raw) = std::env::var("WCDC_VOLUMES") {
        let raw = raw.trim();
        if !raw.is_empty() {
            let volumes: Vec<VolumeConfig> =
                serde_json::from_str(raw).context("WCDC_VOLUMES 不是合法的 JSON 数组")?;
            return normalize_volumes(volumes);
        }
    }

    let config_path = data_dir.join("volumes.json");
    if config_path.is_file() {
        let raw = std::fs::read_to_string(&config_path)
            .with_context(|| format!("无法读取 {}", config_path.display()))?;
        let volumes: Vec<VolumeConfig> =
            serde_json::from_str(&raw).context("volumes.json 格式不正确")?;
        return normalize_volumes(volumes);
    }

    let download_dir = data_dir.join("downloads");
    std::fs::create_dir_all(&download_dir)
        .with_context(|| format!("无法创建默认下载目录 {}", download_dir.display()))?;
    let default = VolumeConfig {
        id: "default".to_string(),
        name: "默认存储盘".to_string(),
        path: download_dir.to_string_lossy().to_string(),
    };
    let raw = serde_json::to_string_pretty(&vec![default.clone()])?;
    std::fs::write(&config_path, raw)
        .with_context(|| format!("无法写入 {}", config_path.display()))?;
    normalize_volumes(vec![default])
}

fn normalize_volumes(volumes: Vec<VolumeConfig>) -> Result<Vec<VolumeConfig>> {
    if volumes.is_empty() {
        bail!("至少需要配置一个存储盘");
    }
    let mut seen = std::collections::HashSet::new();
    let mut normalized = Vec::with_capacity(volumes.len());
    for mut volume in volumes {
        volume.id = volume.id.trim().to_string();
        volume.name = volume.name.trim().to_string();
        volume.path = volume.path.trim().to_string();
        if volume.id.is_empty() || volume.name.is_empty() || volume.path.is_empty() {
            bail!("存储盘的 id/name/path 不能为空");
        }
        if !seen.insert(volume.id.clone()) {
            bail!("存储盘 id 重复: {}", volume.id);
        }
        let path = PathBuf::from(&volume.path);
        let path = if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path)
        };
        std::fs::create_dir_all(&path)
            .with_context(|| format!("无法创建存储盘目录 {}", path.display()))?;
        volume.path = path.to_string_lossy().to_string();
        normalized.push(volume);
    }
    Ok(normalized)
}
