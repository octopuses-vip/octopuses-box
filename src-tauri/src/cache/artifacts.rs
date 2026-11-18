use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

/// 旧版（产物目录按会话定位之前）所有会话共用的产物目录名
///
/// 这个目录已不在 [`SUBDIRS`] 里，不再主动创建；老用户的历史产物还留在里面，
/// 由 [`migrate_legacy`] 按会话归属搬回各自目录，因此只保留这一条常量作为迁移入口。
pub const LEGACY_ARTIFACTS_DIR: &str = "artifacts";

/// 一个产物文件（会话目标目录下的文件）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactInfo {
    /// 产物文件名（不含路径）
    pub(super) name: String,
    /// 字节数
    pub(super) bytes: u64,
    /// 最后写入时间（Unix 秒）
    pub(super) modified_at: u64,
    /// 产物种类：`text` / `image` / `pdf` / `binary`，由扩展名派生（纯计算，不落盘）
    ///
    /// 前端据此决定用「文件」tab 的文本预览、图片预览还是 PDF 预览；
    /// 该字段只是附加信息，旧前端读到多余字段不受影响。
    pub(super) kind: String,
}

/// 由产物文件扩展名派生种类：`image` / `pdf` / `text` / `binary`
///
/// 与前端 `artifactKind()` 保持同一套映射：图片走 blob 预览、PDF 走内置阅读器、
/// 文本类走文本预览，其余一律归为二进制（只展示元信息，不做渲染）。
pub fn artifact_kind(name: &str) -> &'static str {
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "ico" => "image",
        "mp4" => "video",
        "pdf" => "pdf",
        "html" | "htm" | "css" | "js" | "mjs" | "ts" | "tsx" | "jsx" | "json" | "md" | "txt"
        | "csv" | "xml" | "yml" | "yaml" | "log" => "text",
        _ => "binary",
    }
}

/// 校验产物文件名：只允许单个普通文件名，禁止路径分隔符、`.` 与 `..`
///
/// 模型的产出直接落盘，必须在边界上收紧：产物只能平铺在目标目录一层，
/// 不允许再分子目录，也拿不到目录名或父级路径。
pub(super) fn artifact_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("产物文件名不能为空".to_string());
    }
    let mut components = Path::new(name).components();
    let single = matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none()
        && !name.starts_with('.');
    if !single {
        return Err(format!(
            "产物文件名不合法（只允许文件名，不允许路径或隐藏文件）：{name}"
        ));
    }
    Ok(name.to_string())
}

/// 把产物文件名拼到目标目录下，得到磁盘上的真实路径
///
/// 目标目录不再固定为缓存根下的 `artifacts/`：项目会话用 `<项目目录>/output`，
/// 临时会话用 `<缓存目录>/outputs/<日期>`，因此目录由调用方给出。越界风险改由文件名兜住——
/// [`artifact_name`] 保证它是单层文件名，`join` 之后不可能跳出该目录；目录本身要求绝对路径，
/// 避免相对路径落到进程当前目录这种不可预期的位置。
pub(super) fn artifact_target(dir: &Path, raw: &str) -> Result<PathBuf, String> {
    let name = artifact_name(raw)?;
    if dir.as_os_str().is_empty() || !dir.is_absolute() {
        return Err("产物目录必须是绝对路径".to_string());
    }
    Ok(dir.join(name))
}

/// 一次产物写入的结果
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactWriteResult {
    /// 产物在磁盘上的绝对路径（产物已不在缓存根下，不能再按相对缓存根的路径表达）
    pub(super) path: String,
    pub(super) bytes: u64,
}

/// 写入一个文本产物（落在会话的目标目录下，目录不存在时自动创建）
pub fn write_artifact(dir: &Path, name: &str, contents: &str) -> Result<ArtifactWriteResult, String> {
    let target = artifact_target(dir, name)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败: {error}"))?;
    }
    fs::write(&target, contents).map_err(|error| format!("写入 {name} 失败: {error}"))?;
    Ok(ArtifactWriteResult {
        path: target.to_string_lossy().into_owned(),
        bytes: contents.len() as u64,
    })
}

/// 读取一个产物的文本内容
pub fn read_artifact(dir: &Path, name: &str) -> Result<String, String> {
    let target = artifact_target(dir, name)?;
    fs::read_to_string(&target).map_err(|error| format!("读取 {name} 失败: {error}"))
}

/// 产物文件在磁盘上的真实路径。
///
/// `pub(crate)` 供 `fileops` 的「另存为」使用：同一个目录内的文件直接 `fs::copy`，
/// 不必让内容经 base64 绕一圈。
pub(crate) fn artifact_path(dir: &Path, name: &str) -> Result<PathBuf, String> {
    artifact_target(dir, name)
}

/// 写入一个二进制产物（图片等）：`bytes` 为原始字节
///
/// 文本类产物仍走 `write_artifact`：`read_to_string` 读不了 PNG，二进制必须有一条独立通道。
pub fn write_artifact_bytes(
    dir: &Path,
    name: &str,
    bytes: &[u8],
) -> Result<ArtifactWriteResult, String> {
    let target = artifact_target(dir, name)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败: {error}"))?;
    }
    fs::write(&target, bytes).map_err(|error| format!("写入 {name} 失败: {error}"))?;
    Ok(ArtifactWriteResult {
        path: target.to_string_lossy().into_owned(),
        bytes: bytes.len() as u64,
    })
}

/// 读取一个产物的原始字节（图片 / PDF 预览用，文本产物仍走 read_artifact）
pub fn read_artifact_bytes(dir: &Path, name: &str) -> Result<Vec<u8>, String> {
    let target = artifact_target(dir, name)?;
    fs::read(&target).map_err(|error| format!("读取 {name} 失败: {error}"))
}

/// 列出目标目录下的产物，按最后写入时间倒序（同一时间按文件名升序）
///
/// 目录不存在返回空列表：会话还没产出过文件是常态，不该报错。
pub fn list_artifacts(dir: &Path) -> Result<Vec<ArtifactInfo>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(dir).map_err(|error| format!("读取产物目录失败: {error}"))?;
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取产物目录项失败: {error}"))?;
        let meta = entry
            .metadata()
            .map_err(|error| format!("读取产物信息失败: {error}"))?;
        if !meta.is_file() {
            continue;
        }
        let modified_at = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or(0);
        let name = entry.file_name().to_string_lossy().into_owned();
        out.push(ArtifactInfo {
            kind: artifact_kind(&name).to_string(),
            name,
            bytes: meta.len(),
            modified_at,
        });
    }
    out.sort_by(|left, right| {
        right
            .modified_at
            .cmp(&left.modified_at)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(out)
}

/// 确保 `.gitignore` 里存在 `entry` 这一行（已存在等价行则原样返回，不重复追加）
///
/// 项目目录下的 `output/` 是模型产出的临时成品，不该进版本库；首次创建时替用户补一行，
/// 免得每次产出都在 `git status` 里冒出来。文件不存在就新建，已有内容一律保留、只在末尾补行。
pub(super) fn ensure_gitignore_entry(file: &Path, entry: &str) -> Result<(), String> {
    let wanted = entry.trim();
    if wanted.is_empty() {
        return Ok(());
    }
    // 比对时忽略结尾斜杠：`output` 与 `output/` 在 gitignore 里等价，不能因为写法不同就补重复行
    let normalized = wanted.trim_end_matches('/');
    let mut body = if file.exists() {
        fs::read_to_string(file).map_err(|error| format!("读取 .gitignore 失败: {error}"))?
    } else {
        String::new()
    };
    let exists = body.lines().any(|line| {
        let line = line.trim();
        !line.is_empty() && !line.starts_with('#') && line.trim_end_matches('/') == normalized
    });
    if exists {
        return Ok(());
    }
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }
    body.push_str(wanted);
    body.push('\n');
    fs::write(file, body).map_err(|error| format!("写入 .gitignore 失败: {error}"))
}

/// 准备产物目录：建目录，并按需在项目的 `.gitignore` 里补一行忽略规则
///
/// 只有项目会话需要 `gitignore`/`entry`（`<项目目录>/output` 配 `output/`）；
/// 临时会话落在缓存区，本来就不进版本库，两个参数留空即可。
pub fn prepare_dir(dir: &Path, gitignore: Option<&Path>, entry: Option<&str>) -> Result<(), String> {
    if dir.as_os_str().is_empty() || !dir.is_absolute() {
        return Err("产物目录必须是绝对路径".to_string());
    }
    fs::create_dir_all(dir).map_err(|error| format!("创建产物目录失败: {error}"))?;
    match (gitignore, entry) {
        (Some(file), Some(entry)) => ensure_gitignore_entry(file, entry),
        _ => Ok(()),
    }
}

/// 一条旧产物的迁移目标：文件名 + 它应归属的会话产物目录（绝对路径）
///
/// 归属只能由前端算：项目路径存在界面侧的持久化里，库里没有，
/// 因此后端只负责「按名字把文件搬到指定目录」这一件事。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactMigrationTarget {
    pub(super) name: String,
    pub(super) dir: String,
}

/// 旧产物迁移结果
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactMigrationResult {
    /// 成功搬走的文件数
    pub(super) moved: usize,
    /// 原样留在旧目录的文件数：认不出归属、目标已有同名文件、目标目录不合法
    pub(super) skipped: usize,
}

/// 把旧版共享产物目录 `<缓存>/artifacts/` 里的文件搬回各自会话的产物目录
///
/// 产物目录改成按会话定位后，历史产物留在旧目录里，右栏按新目录列就什么都看不到。
/// 这里按文件名匹配前端算好的归属表：命中就搬走，认不出归属的一律留在原地（不猜、不删），
/// 目标目录已有同名文件时也跳过——旧目录里的副本是历史版本，不该覆盖会话里更新的那份。
///
/// 跨挂载点（项目目录在另一块盘 / 网络卷）时 `rename` 会失败，退化成复制后删除。
pub fn migrate_legacy(
    root: &Path,
    targets: &[ArtifactMigrationTarget],
) -> Result<ArtifactMigrationResult, String> {
    let mut result = ArtifactMigrationResult::default();
    let legacy = root.join(LEGACY_ARTIFACTS_DIR);
    if !legacy.is_dir() {
        return Ok(result);
    }
    // 同名只认第一个目标：前端按「最近一次写出」排序，重复项是同一会话的重复调用
    let mut plan: HashMap<&str, &str> = HashMap::new();
    for target in targets {
        plan.entry(target.name.as_str()).or_insert(target.dir.as_str());
    }
    let entries = fs::read_dir(&legacy).map_err(|error| format!("读取旧产物目录失败: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取旧产物目录项失败: {error}"))?;
        let meta = entry
            .metadata()
            .map_err(|error| format!("读取旧产物信息失败: {error}"))?;
        if !meta.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let source = entry.path();
        let Some(dir) = plan.get(name.as_str()) else {
            result.skipped += 1;
            continue;
        };
        // 复用产物路径校验：目录必须是绝对路径、文件名必须单层，越界直接跳过而不是整批失败
        let destination = match artifact_target(Path::new(dir), &name) {
            Ok(path) => path,
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        if destination.exists() {
            result.skipped += 1;
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建目标目录失败: {error}"))?;
        }
        if fs::rename(&source, &destination).is_err() {
            fs::copy(&source, &destination).map_err(|error| format!("迁移 {name} 失败: {error}"))?;
            fs::remove_file(&source).map_err(|error| format!("清理 {name} 失败: {error}"))?;
        }
        result.moved += 1;
    }
    Ok(result)
}
