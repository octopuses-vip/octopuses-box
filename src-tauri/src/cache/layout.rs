use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// 缓存目录的固定子目录
///
/// `outputs/` 放**临时会话**写出的产物（按天分一层 `YYYY-MM-DD/`）——项目会话的产物直接落在
/// 项目目录的 `output/` 下，不进缓存区，右栏「文件」tab 按当前会话的目标目录列；差异与来源属于
/// 内部快照，单独放 `snapshots/`，避免混进产物列表被当成模型产出。
pub const SUBDIRS: [&str; 5] = ["temp", "logs", "sessions", "outputs", "snapshots"];

/// 缓存根目录下的元信息文件
pub(super) const MANIFEST: &str = "manifest.json";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubdirInfo {
    pub(super) name: String,
    pub(super) file_count: usize,
    pub(super) bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    pub(super) path: String,
    pub(super) exists: bool,
    pub(super) total_bytes: u64,
    pub(super) total_files: usize,
    /// manifest.json 中记录的创建时间（Unix 秒）
    pub(super) created_at: Option<u64>,
    pub(super) subdirs: Vec<SubdirInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheFileInfo {
    /// 相对缓存根目录的路径
    pub(super) path: String,
    pub(super) bytes: u64,
}

/// 当前 Unix 秒（开发者 Jan）：系统时钟异常（早于纪元）时退回 0，避免调用方拿到 panic
pub(super) fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// 把相对路径解析到缓存根目录下，拒绝绝对路径与 `..`，防止写到缓存目录之外
pub(super) fn resolve(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if relative.trim().is_empty() || rel.is_absolute() {
        return Err("必须提供相对缓存根目录的路径".to_string());
    }
    let mut target = root.to_path_buf();
    for component in rel.components() {
        match component {
            Component::Normal(part) => target.push(part),
            Component::CurDir => {}
            _ => return Err("路径中不允许出现 .. 或根前缀".to_string()),
        }
    }
    if target == root {
        return Err("路径必须指向缓存目录内的文件".to_string());
    }
    Ok(target)
}

/// 统计目录下的文件数量与占用字节数
pub(super) fn measure(dir: &Path) -> Result<(usize, u64), String> {
    if !dir.is_dir() {
        return Ok((0, 0));
    }
    let mut files = 0usize;
    let mut bytes = 0u64;
    let entries = fs::read_dir(dir).map_err(|error| format!("读取目录失败: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取目录项失败: {error}"))?;
        let path = entry.path();
        let meta = entry
            .metadata()
            .map_err(|error| format!("读取文件信息失败: {error}"))?;
        if meta.is_dir() {
            let (child_files, child_bytes) = measure(&path)?;
            files += child_files;
            bytes += child_bytes;
        } else {
            files += 1;
            bytes += meta.len();
        }
    }
    Ok((files, bytes))
}

/// 从 manifest 读取缓存目录的创建时间（开发者 Jan）。
///
/// manifest 是用户可手工编辑的 JSON，字段可能缺失或被写坏，
/// 因此全程用 `?` 兜底成 None——创建时间只用于展示，读不到不该影响缓存目录本身可用。
pub(super) fn read_created_at(root: &Path) -> Option<u64> {
    let body = fs::read_to_string(root.join(MANIFEST)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&body).ok()?;
    value.get("createdAt")?.as_u64()
}

/// 创建缓存目录树，并写入 manifest（已存在时不覆盖）
pub fn init(root: &Path) -> Result<CacheInfo, String> {
    fs::create_dir_all(root).map_err(|error| format!("创建缓存目录失败: {error}"))?;
    for name in SUBDIRS {
        fs::create_dir_all(root.join(name))
            .map_err(|error| format!("创建子目录 {name} 失败: {error}"))?;
    }
    let manifest = root.join(MANIFEST);
    if !manifest.exists() {
        let body = serde_json::json!({
            "app": "octopuses",
            "version": env!("CARGO_PKG_VERSION"),
            "createdAt": now_unix(),
            "subdirs": SUBDIRS,
        });
        let text = serde_json::to_string_pretty(&body)
            .map_err(|error| format!("生成 manifest 失败: {error}"))?;
        fs::write(&manifest, text).map_err(|error| format!("写入 manifest 失败: {error}"))?;
    }
    info(root)
}

/// 汇总缓存目录的路径、子目录统计与创建时间
pub fn info(root: &Path) -> Result<CacheInfo, String> {
    let mut subdirs = Vec::with_capacity(SUBDIRS.len());
    let mut total_files = 0usize;
    let mut total_bytes = 0u64;
    for name in SUBDIRS {
        let (file_count, bytes) = measure(&root.join(name))?;
        total_files += file_count;
        total_bytes += bytes;
        subdirs.push(SubdirInfo {
            name: name.to_string(),
            file_count,
            bytes,
        });
    }
    Ok(CacheInfo {
        path: root.to_string_lossy().into_owned(),
        exists: root.is_dir(),
        total_bytes,
        total_files,
        created_at: read_created_at(root),
        subdirs,
    })
}

/// 覆盖写入一个缓存文件（自动创建父目录）
pub fn write_file(root: &Path, relative: &str, contents: &str) -> Result<CacheFileInfo, String> {
    let target = resolve(root, relative)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败: {error}"))?;
    }
    fs::write(&target, contents).map_err(|error| format!("写入 {relative} 失败: {error}"))?;
    Ok(CacheFileInfo {
        path: relative.to_string(),
        bytes: contents.len() as u64,
    })
}

/// 追加写入一个缓存文件（用于日志，自动创建父目录）
pub fn append_file(root: &Path, relative: &str, contents: &str) -> Result<CacheFileInfo, String> {
    use std::io::Write;

    let target = resolve(root, relative)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败: {error}"))?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&target)
        .map_err(|error| format!("打开 {relative} 失败: {error}"))?;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("写入 {relative} 失败: {error}"))?;
    Ok(CacheFileInfo {
        path: relative.to_string(),
        bytes: contents.len() as u64,
    })
}

/* ============================ 产物文件 ============================ */

/// 读取一个缓存文件的文本内容
pub fn read_file(root: &Path, relative: &str) -> Result<String, String> {
    let target = resolve(root, relative)?;
    fs::read_to_string(&target).map_err(|error| format!("读取 {relative} 失败: {error}"))
}

/// 清空缓存内容：`temp` 只清临时文件，`all` 清空全部子目录
pub fn clear(root: &Path, scope: &str) -> Result<CacheInfo, String> {
    let targets: &[&str] = match scope {
        "temp" => &["temp"],
        "all" => &SUBDIRS,
        other => return Err(format!("不支持的清理范围: {other}")),
    };
    for name in targets {
        let dir = root.join(name);
        if dir.is_dir() {
            fs::remove_dir_all(&dir).map_err(|error| format!("清空 {name} 失败: {error}"))?;
        }
        fs::create_dir_all(&dir).map_err(|error| format!("重建 {name} 失败: {error}"))?;
    }
    info(root)
}
