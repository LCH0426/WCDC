use std::path::{Component, Path, PathBuf};

use serde::Serialize;

/// One filesystem root exposed by the storage browser (a Windows drive or a
/// Unix mount point).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageRoot {
    pub name: String,
    pub path: String,
    pub is_removable: bool,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub writable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseEntry {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseResult {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<BrowseEntry>,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub writable: bool,
    pub is_root: bool,
}

pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

pub fn roots() -> Vec<StorageRoot> {
    let mut roots = platform_roots();
    // Keep the list stable and de-duplicated by path.
    roots.sort_by(|left, right| left.path.cmp(&right.path));
    roots.dedup_by(|left, right| left.path == right.path);
    roots
}

/// Roots available to an fnOS package: only user-authorized / app-shared dirs.
pub fn limited_roots(paths: &[PathBuf]) -> Vec<StorageRoot> {
    let mut roots = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for path in paths {
        let Ok(canonical) = std::fs::canonicalize(path) else {
            continue;
        };
        if !canonical.is_dir() {
            continue;
        }
        let key = canonical.to_string_lossy().to_string();
        if !seen.insert(key) {
            continue;
        }
        let mut root = root_for(&canonical);
        root.name = canonical.to_string_lossy().to_string();
        root.is_removable = false;
        roots.push(root);
    }
    roots.sort_by(|left, right| left.path.cmp(&right.path));
    roots
}

/// Reject any path outside the authorized roots. Nonexistent destinations are
/// checked against their nearest existing ancestor.
pub fn ensure_within(path: &Path, allowed: &[PathBuf]) -> Result<(), String> {
    if allowed.is_empty() {
        return Err("飞牛应用设置中没有已授权的文件夹".to_string());
    }
    let roots: Vec<PathBuf> = allowed
        .iter()
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .filter(|path| path.is_dir())
        .collect();
    if roots.is_empty() {
        return Err("飞牛应用设置中的授权目录不存在".to_string());
    }
    let target = std::fs::canonicalize(path)
        .ok()
        .or_else(|| {
            let mut current = path;
            loop {
                if let Ok(canonical) = std::fs::canonicalize(current) {
                    return Some(canonical);
                }
                current = current.parent()?;
            }
        })
        .ok_or_else(|| format!("路径不存在: {}", path.display()))?;
    if roots.iter().any(|root| target.starts_with(root)) {
        Ok(())
    } else {
        Err("该路径不在飞牛应用已授权的文件夹内".to_string())
    }
}

fn platform_roots() -> Vec<StorageRoot> {
    #[cfg(windows)]
    {
        windows_roots()
    }
    #[cfg(target_os = "macos")]
    {
        macos_roots()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        linux_roots()
    }
    #[cfg(not(any(windows, unix)))]
    {
        vec![root_for(Path::new("/"))]
    }
}

#[cfg(windows)]
fn windows_roots() -> Vec<StorageRoot> {
    let mut roots = Vec::new();
    for letter in b'C'..=b'Z' {
        let path = format!("{}:\\", letter as char);
        let candidate = PathBuf::from(&path);
        if candidate.is_dir() {
            let mut root = root_for(&candidate);
            root.name = format!("{}:", letter as char);
            root.is_removable = !matches!(letter, b'C');
            roots.push(root);
        }
    }
    if roots.is_empty() {
        roots.push(root_for(Path::new("C:\\")));
    }
    roots
}

#[cfg(target_os = "macos")]
fn macos_roots() -> Vec<StorageRoot> {
    let mut roots = vec![root_for(Path::new("/"))];
    if let Ok(entries) = std::fs::read_dir("/Volumes") {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                roots.push(root_for(&path));
            }
        }
    }
    roots
}

#[cfg(all(unix, not(target_os = "macos")))]
fn linux_roots() -> Vec<StorageRoot> {
    use std::collections::HashSet;
    use std::fs;

    const PSEUDO_FS: &[&str] = &[
        "proc",
        "sysfs",
        "devtmpfs",
        "devpts",
        "tmpfs",
        "cgroup",
        "cgroup2",
        "pstore",
        "bpf",
        "autofs",
        "configfs",
        "debugfs",
        "tracefs",
        "securityfs",
        "mqueue",
        "hugetlbfs",
        "ramfs",
        "squashfs",
        "nsfs",
        "efivarfs",
        "selinuxfs",
        "rpc_pipefs",
        "binfmt_misc",
        "nfsd",
        "sunrpc",
        "fusectl",
        "overlay",
        "aufs",
        "procfs",
        "sys",
        "none",
    ];

    let mut roots = vec![root_for(Path::new("/"))];
    let mut seen = HashSet::from(["/".to_string()]);
    if let Ok(mounts) = fs::read_to_string("/proc/mounts") {
        for line in mounts.lines() {
            let mut fields = line.split_whitespace();
            let _device = fields.next();
            let Some(mount_point) = fields.next() else {
                continue;
            };
            let fstype = fields.next().unwrap_or_default();
            if PSEUDO_FS.contains(&fstype) {
                continue;
            }
            let mount_point = unescape_mount_path(mount_point);
            if !mount_point.starts_with('/') || !Path::new(&mount_point).is_dir() {
                continue;
            }
            if !seen.insert(mount_point.clone()) {
                continue;
            }
            let mut root = root_for(Path::new(&mount_point));
            root.name = mount_point.clone();
            roots.push(root);
        }
    }
    roots
}

#[cfg(all(unix, not(target_os = "macos")))]
fn unescape_mount_path(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = String::with_capacity(value.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\\' && index + 3 < bytes.len() {
            let octal = &value[index + 1..index + 4];
            if let Ok(code) = u8::from_str_radix(octal, 8) {
                output.push(code as char);
                index += 4;
                continue;
            }
        }
        output.push(bytes[index] as char);
        index += 1;
    }
    output
}

fn root_for(path: &Path) -> StorageRoot {
    let (total_bytes, free_bytes) = capacity(path);
    let name = if path.as_os_str().is_empty() {
        "/".to_string()
    } else {
        path.to_string_lossy().to_string()
    };
    StorageRoot {
        name,
        path: path.to_string_lossy().to_string(),
        is_removable: false,
        total_bytes,
        free_bytes,
        writable: probe_writable(path),
    }
}

pub fn capacity(path: &Path) -> (u64, u64) {
    if !path.is_dir() {
        return (0, 0);
    }
    (
        fs2::total_space(path).unwrap_or(0),
        fs2::available_space(path).unwrap_or(0),
    )
}

pub fn probe_writable(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    let probe = path.join(format!(".wcdc-write-test-{}", uuid::Uuid::new_v4()));
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = std::fs::remove_file(probe);
            true
        }
        Err(_) => false,
    }
}

fn normalize_absolute(path: &Path) -> Result<PathBuf, String> {
    let absolute = std::path::absolute(path).map_err(|error| format!("路径无效: {error}"))?;
    let mut normalized = PathBuf::new();
    let mut normal_depth = 0_usize;
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if normal_depth > 0 {
                    normalized.pop();
                    normal_depth -= 1;
                }
            }
            Component::Normal(part) => {
                normalized.push(part);
                normal_depth += 1;
            }
        }
    }
    Ok(normalized)
}

/// Browse a directory. `path == None` starts at the user's home directory.
pub fn browse_scoped(
    path: Option<&str>,
    allowed: Option<&[PathBuf]>,
) -> Result<BrowseResult, String> {
    let canonical_allowed: Option<Vec<PathBuf>> = allowed.map(|paths| {
        paths
            .iter()
            .filter_map(|path| std::fs::canonicalize(path).ok())
            .filter(|path| path.is_dir())
            .collect()
    });
    if let Some(roots) = &canonical_allowed {
        if roots.is_empty() {
            return Err("飞牛应用设置中没有已授权的文件夹".to_string());
        }
    }
    let requested = match path.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => PathBuf::from(value),
        None => canonical_allowed
            .as_ref()
            .and_then(|roots| roots.first().cloned())
            .unwrap_or_else(home_dir),
    };
    if !requested.is_absolute() {
        return Err("目录必须是绝对路径".to_string());
    }
    let path = normalize_absolute(&requested)?;
    if !path.is_dir() {
        return Err(format!("目录不存在: {}", path.display()));
    }
    if let Some(roots) = &canonical_allowed {
        ensure_within(&path, roots)?;
    }
    let path = std::fs::canonicalize(&path).unwrap_or(path);

    let mut entries = Vec::new();
    let read = std::fs::read_dir(&path).map_err(|error| {
        format!("无法读取目录 {}: {error}", path.display())
    })?;
    for entry in read.flatten() {
        let entry_path = entry.path();
        if !entry_path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "." || name == ".." {
            continue;
        }
        entries.push(BrowseEntry {
            name,
            path: entry_path.to_string_lossy().to_string(),
        });
    }
    entries.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
    });

    let parent = path
        .parent()
        .filter(|parent| *parent != path)
        .filter(|parent| {
            canonical_allowed
                .as_ref()
                .map(|roots| roots.iter().any(|root| parent.starts_with(root)))
                .unwrap_or(true)
        })
        .map(|parent| parent.to_string_lossy().to_string());
    let (total_bytes, free_bytes) = capacity(&path);
    let is_root = parent.is_none()
        || canonical_allowed
            .as_ref()
            .map(|roots| roots.iter().any(|root| root == &path))
            .unwrap_or_else(|| {
                roots()
                    .iter()
                    .any(|root| Path::new(&root.path) == path.as_path())
            });
    Ok(BrowseResult {
        path: path.to_string_lossy().to_string(),
        parent,
        entries,
        total_bytes,
        free_bytes,
        writable: probe_writable(&path),
        is_root,
    })
}

pub fn create_folder_scoped(
    parent: &str,
    name: &str,
    allowed: Option<&[PathBuf]>,
) -> Result<String, String> {
    if let Some(allowed) = allowed {
        let path = normalize_absolute(Path::new(parent.trim()))?;
        ensure_within(&path, allowed)?;
    }
    create_folder(parent, name)
}

pub fn create_folder(parent: &str, name: &str) -> Result<String, String> {
    let parent = normalize_absolute(Path::new(parent.trim()))?;
    if !parent.is_dir() {
        return Err(format!("父目录不存在: {}", parent.display()));
    }
    let name = name.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
    {
        return Err("文件夹名称不合法".to_string());
    }
    let target = parent.join(name);
    if target.exists() {
        return Err("同名文件或文件夹已存在".to_string());
    }
    std::fs::create_dir(&target).map_err(|error| format!("创建文件夹失败: {error}"))?;
    Ok(target.to_string_lossy().to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBrowseEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBrowseResult {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FileBrowseEntry>,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub writable: bool,
    pub is_root: bool,
}

fn modified_millis(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn is_root_path(path: &Path) -> bool {
    if path.parent().is_none() {
        return true;
    }
    roots()
        .iter()
        .any(|root| Path::new(&root.path) == path)
}

/// Browse a directory including files (server file manager).
pub fn browse_files_scoped(
    path: Option<&str>,
    allowed: Option<&[PathBuf]>,
) -> Result<FileBrowseResult, String> {
    let canonical_allowed: Option<Vec<PathBuf>> = allowed.map(|paths| {
        paths
            .iter()
            .filter_map(|path| std::fs::canonicalize(path).ok())
            .filter(|path| path.is_dir())
            .collect()
    });
    if let Some(roots) = &canonical_allowed {
        if roots.is_empty() {
            return Err("飞牛应用设置中没有已授权的文件夹".to_string());
        }
    }
    let requested = match path.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => PathBuf::from(value),
        None => canonical_allowed
            .as_ref()
            .and_then(|roots| roots.first().cloned())
            .unwrap_or_else(home_dir),
    };
    if !requested.is_absolute() {
        return Err("目录必须是绝对路径".to_string());
    }
    let path = normalize_absolute(&requested)?;
    if !path.is_dir() {
        return Err(format!("目录不存在: {}", path.display()));
    }
    if let Some(roots) = &canonical_allowed {
        ensure_within(&path, roots)?;
    }
    let path = std::fs::canonicalize(&path).unwrap_or(path);

    let mut entries = Vec::new();
    let read = std::fs::read_dir(&path)
        .map_err(|error| format!("无法读取目录 {}: {error}", path.display()))?;
    for entry in read.flatten() {
        let entry_path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "." || name == ".." {
            continue;
        }
        let is_dir = metadata.is_dir();
        if !is_dir && !metadata.is_file() {
            continue;
        }
        entries.push(FileBrowseEntry {
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir,
            size: if is_dir { 0 } else { metadata.len() },
            modified_at: modified_millis(&metadata),
        });
    }
    entries.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    let parent = path
        .parent()
        .filter(|parent| *parent != path)
        .filter(|parent| {
            canonical_allowed
                .as_ref()
                .map(|roots| roots.iter().any(|root| parent.starts_with(root)))
                .unwrap_or(true)
        })
        .map(|parent| parent.to_string_lossy().to_string());
    let (total_bytes, free_bytes) = capacity(&path);
    Ok(FileBrowseResult {
        path: path.to_string_lossy().to_string(),
        parent,
        entries,
        total_bytes,
        free_bytes,
        writable: probe_writable(&path),
        is_root: canonical_allowed
            .as_ref()
            .map(|roots| roots.iter().any(|root| root == &path))
            .unwrap_or_else(|| is_root_path(&path)),
    })
}

pub fn resolve_file_scoped(
    path: &str,
    allowed: Option<&[PathBuf]>,
) -> Result<PathBuf, String> {
    let path = resolve_file(path)?;
    if let Some(allowed) = allowed {
        ensure_within(&path, allowed)?;
    }
    Ok(path)
}

/// Resolve an absolute regular file for streaming to the browser.
pub fn resolve_file(path: &str) -> Result<PathBuf, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("文件路径不能为空".to_string());
    }
    let requested = PathBuf::from(path);
    if !requested.is_absolute() {
        return Err("文件路径必须是绝对路径".to_string());
    }
    let path = normalize_absolute(&requested)?;
    let metadata =
        std::fs::metadata(&path).map_err(|error| format!("无法读取文件 {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("不是普通文件: {}", path.display()));
    }
    Ok(path)
}

pub fn resolve_destination_scoped(
    destination: &str,
    allowed: Option<&[PathBuf]>,
) -> Result<PathBuf, String> {
    if let Some(allowed) = allowed {
        let requested = PathBuf::from(destination.trim());
        if !requested.is_absolute() {
            return Err("下载目录必须是绝对路径".to_string());
        }
        let path = normalize_absolute(&requested)?;
        ensure_within(&path, allowed)?;
    }
    let path = resolve_destination(destination)?;
    if let Some(allowed) = allowed {
        ensure_within(&path, allowed)?;
    }
    Ok(path)
}

/// Resolve a user-chosen absolute directory, creating it if needed.
/// Unlike the configured-volume path, this intentionally allows any location
/// the server process can write to.
pub fn resolve_destination(destination: &str) -> Result<PathBuf, String> {
    let destination = destination.trim();
    if destination.is_empty() {
        return Err("下载目录不能为空".to_string());
    }
    let requested = PathBuf::from(destination);
    if !requested.is_absolute() {
        return Err("下载目录必须是绝对路径".to_string());
    }
    let path = normalize_absolute(&requested)?;
    if path.is_file() {
        return Err("下载目录是一个文件，请选择文件夹".to_string());
    }
    std::fs::create_dir_all(&path)
        .map_err(|error| format!("无法创建下载目录 {}: {error}", path.display()))?;
    if !probe_writable(&path) {
        return Err(format!("目录不可写: {}", path.display()));
    }
    Ok(path)
}
