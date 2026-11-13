//! 文件搬运与工作区文件通道（开发者 Jan）。
//!
//! 这里只做「把一个已存在的文件搬到另一个位置」「读出文件字节」这类与业务无关的动作，
//! 由三条链路共用，避免导入、导出、预览各写一套复制/读取逻辑：
//!   * 导入：用户拖入或选中的本机图纸 → 会话工作目录的 `imports/` 子目录；
//!   * 导出：产物或工作区里的文件 → 用户在系统「另存为」对话框里选定的位置；
//!   * 预览：工作区里的二进制图纸（STEP / IGES）→ base64 交给前端 WASM 解析。
//!
//! 位置一律用 [`FileLocation`] 描述，读写两侧共用同一套校验：工作区路径走
//! [`workspace::resolve_path`]（拒绝逃逸工作区），产物走调用方给出的产物目录（项目 `output/`
//! 或缓存 `outputs/<日期>/`），本机绝对路径只会在用户主动触发（拖放 / 文件对话框）时出现。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::cache;
use crate::workspace;

/// 单个导入文件的大小上限。
///
/// 导入会把整个文件复制进工作区，超大文件既拖慢界面也未必是图纸，
/// 因此在边界上直接拒绝，由前端把失败原因原样展示给用户。
const MAX_IMPORT_BYTES: u64 = 200 * 1024 * 1024;
/// 同名文件自动加序号时的最大试探次数，用尽即报错，不做无限循环
const MAX_NAME_ATTEMPTS: u32 = 1000;
const MAX_CONTEXT_BYTES: u64 = 10 * 1024 * 1024;
const MAX_CONTEXT_ENTRIES: usize = 200;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ContextPathData {
    File {
        name: String,
        encoded: String,
    },
    Folder {
        entries: Vec<String>,
        truncated: bool,
    },
}

/// 函数级说明（开发者 Jan）：执行 resolve_context_path 的单一职责，并返回可供调用方继续处理的结果。
fn resolve_context_path(path: &str, base: Option<&str>) -> Result<PathBuf, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("上下文路径不能为空".to_string());
    }
    if path == "~" || path.starts_with("~/") || path.starts_with("~\\") {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .ok_or_else(|| "无法定位用户主目录，请填写绝对路径".to_string())?;
        return Ok(PathBuf::from(home).join(path.get(2..).unwrap_or("")));
    }
    let target = PathBuf::from(path);
    if target.is_absolute() {
        return Ok(target);
    }
    let root = base
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "相对路径需要会话工作目录，请选择工作目录或填写绝对路径".to_string())?;
    let root = Path::new(root);
    if !root.is_absolute() {
        return Err("会话工作目录必须是绝对路径".to_string());
    }
    Ok(root.join(target))
}

/// 函数级说明（开发者 Jan）：执行 read_context_path 的单一职责，并返回可供调用方继续处理的结果。
fn read_context_path(path: &Path) -> Result<ContextPathData, String> {
    read_context_path_with_limit(path, MAX_CONTEXT_BYTES)
}

/// 知识库可传入用户配置的读取上限；元信息检查与实际读取共用同一限制。
fn read_context_path_with_limit(path: &Path, max_bytes: u64) -> Result<ContextPathData, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    if metadata.is_dir() {
        let iterator = fs::read_dir(path).map_err(|error| format!("读取目录失败：{error}"))?;
        let mut entries = Vec::new();
        for entry in iterator.take(MAX_CONTEXT_ENTRIES + 1) {
            let entry = entry.map_err(|error| format!("读取目录项失败：{error}"))?;
            let suffix = if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                "/"
            } else {
                ""
            };
            entries.push(format!("{}{suffix}", entry.file_name().to_string_lossy()));
        }
        let truncated = entries.len() > MAX_CONTEXT_ENTRIES;
        entries.truncate(MAX_CONTEXT_ENTRIES);
        entries.sort();
        return Ok(ContextPathData::Folder { entries, truncated });
    }
    if !metadata.is_file() {
        return Err("上下文只支持普通文件或目录".to_string());
    }
    if metadata.len() > max_bytes {
        return Err(format!("文件超过 {} MB，请调整上传限制或拆分后添加", max_bytes / (1024 * 1024)));
    }
    // take 同时约束检查大小之后仍可能增长的文件，避免一次读取吞掉全部内存。
    let file = fs::File::open(path).map_err(|error| format!("打开文件失败：{error}"))?;
    let mut bytes = Vec::new();
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取文件失败：{error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("文件超过 {} MB，请调整上传限制或拆分后添加", max_bytes / (1024 * 1024)));
    }
    Ok(ContextPathData::File {
        name: file_label(path),
        encoded: cache::base64_encode(&bytes),
    })
}

/// 用户主动附加的会话上下文：只读、限长，不借助 shell，路径规则跟随本机平台。
#[tauri::command]
pub async fn context_read_path(
    path: String,
    base: Option<String>,
    max_file_mb: Option<u64>,
) -> Result<ContextPathData, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = resolve_context_path(&path, base.as_deref())?;
        match max_file_mb {
            None => read_context_path(&target),
            Some(limit) if (1..=200).contains(&limit) => read_context_path_with_limit(&target, limit * 1024 * 1024),
            Some(_) => Err("单文件大小上限必须为 1–200 MB".into()),
        }
    })
    .await
    .map_err(|error| format!("读取上下文失败：{error}"))?
}

/// 一个文件所在的位置：三条链路的统一描述。
///
/// 前端传出的键名与其余命令一致用 camelCase，因此各变体单独声明 `rename_all`。
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FileLocation {
    /// 会话工作目录内的文件（相对工作区的路径）
    #[serde(rename_all = "camelCase")]
    Workspace { project_path: String, path: String },
    /// 产物目录（项目 `output/` 或缓存 `outputs/<日期>/`）下由模型写出的产物
    #[serde(rename_all = "camelCase")]
    Artifact { dir: String, name: String },
    /// 本机绝对路径
    Absolute { path: String },
}

/// 一次导入的结果：逐项返回，整批不因单项失败而中断
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    /// 导入前的本机绝对路径
    source: String,
    /// 导入后相对工作区的路径（正斜杠）；失败时空串
    path: String,
    /// 落盘字节数；失败时为 0
    bytes: u64,
    ok: bool,
    /// 失败原因；成功时空串
    error: String,
}

/// 一次另存为 / 读取的结果
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTransferResult {
    /// 落盘后的绝对路径
    path: String,
    bytes: u64,
}

/// 工作区某个目录下的一项文件（与 `cache::ArtifactInfo` 同形，前端可复用同一套渲染）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    /// 文件名（不含路径）
    name: String,
    bytes: u64,
    /// 最后写入时间（Unix 秒）
    modified_at: u64,
}

/* ============================ 路径与校验 ============================ */

/// 校验一个本机绝对路径确实是可读的普通文件
fn ensure_absolute_file(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("需要本机绝对路径：{}", path.display()));
    }
    let meta =
        fs::metadata(path).map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("不是文件：{}", path.display()));
    }
    Ok(())
}

/// 取文件名用于展示与报错；拿不到时退回完整路径
fn file_label(path: &Path) -> String {
    path.file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// 把 [`FileLocation`] 解析成可读的磁盘路径，同时给出供报错使用的展示名
fn resolve_source(source: &FileLocation) -> Result<(String, PathBuf), String> {
    match source {
        FileLocation::Workspace { project_path, path } => {
            let (root, target) = workspace::resolve_path(project_path, path, false)?;
            Ok((workspace::display_path(&root, &target), target))
        }
        FileLocation::Artifact { dir, name } => {
            let target = cache::artifact_path(Path::new(dir), name)?;
            Ok((name.clone(), target))
        }
        FileLocation::Absolute { path } => {
            let target = PathBuf::from(path);
            ensure_absolute_file(&target)?;
            Ok((file_label(&target), target))
        }
    }
}

/// 在目标目录里找一个不冲突的文件名：`cube.step` → `cube (1).step` → `cube (2).step` ……
///
/// 导入的语义是「搬进来」而不是「覆盖」，因此同名一律让位，绝不动工作区里已有的文件。
fn unique_target(dest: &Path, name: &str) -> Result<PathBuf, String> {
    let candidate = dest.join(name);
    if !candidate.exists() {
        return Ok(candidate);
    }
    // 拆成「主干 + 扩展名」再拼序号，保证 `a.step` 得到 `a (1).step` 而不是 `a.step (1)`
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(name);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    for index in 1..=MAX_NAME_ATTEMPTS {
        let file_name = if extension.is_empty() {
            format!("{stem} ({index})")
        } else {
            format!("{stem} ({index}).{extension}")
        };
        let candidate = dest.join(&file_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!("目标目录里同名文件过多，请先清理后再导入：{name}"))
}

/// 复制单个文件进工作区，返回这一项的成败与原因
fn import_one(root: &Path, dest: &Path, source: &str) -> ImportOutcome {
    let failure = |error: String| ImportOutcome {
        source: source.to_string(),
        path: String::new(),
        bytes: 0,
        ok: false,
        error,
    };

    let from = PathBuf::from(source.trim());
    if let Err(error) = ensure_absolute_file(&from) {
        return failure(error);
    }
    let size = fs::metadata(&from).map(|meta| meta.len()).unwrap_or(0);
    if size > MAX_IMPORT_BYTES {
        return failure(format!(
            "文件超过 {} MB 上限：{}",
            MAX_IMPORT_BYTES / (1024 * 1024),
            file_label(&from)
        ));
    }

    let target = match unique_target(dest, &file_label(&from)) {
        Ok(target) => target,
        Err(error) => return failure(error),
    };
    if let Some(parent) = target.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            return failure(format!("创建目录 {} 失败：{error}", parent.display()));
        }
    }
    match fs::copy(&from, &target) {
        Ok(bytes) => ImportOutcome {
            source: source.to_string(),
            path: workspace::display_path(root, &target),
            bytes,
            ok: true,
            error: String::new(),
        },
        Err(error) => failure(format!("复制到工作区失败：{error}")),
    }
}

/* ============================ Tauri 命令 ============================ */

/// 把一批本机文件复制进工作区的指定子目录（图纸导入用，前端传 `imports`）。
///
/// 逐项返回结果：某个文件不合格（不存在、非文件、超限、重名过多）只记这一项的失败，
/// 其余照常导入——拖进来十个文件只因为一个坏了就全丢，对用户没有好处。
#[tauri::command]
pub async fn workspace_import_files(
    project_path: String,
    dest_dir: String,
    sources: Vec<String>,
) -> Result<Vec<ImportOutcome>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 目标目录同样要在工作区内：复用与读写文件一致的相对路径校验
        let (root, dest) = workspace::resolve_path(&project_path, &dest_dir, true)?;
        fs::create_dir_all(&dest)
            .map_err(|error| format!("创建目录 {} 失败：{error}", dest.display()))?;
        Ok(sources
            .iter()
            .map(|source| import_one(&root, &dest, source))
            .collect())
    })
    .await
    .map_err(|error| format!("导入文件失败：{error}"))?
}

/// 把产物 / 工作区文件 / 本机文件另存到用户选定的位置。
///
/// 目标路径来自系统「另存为」对话框，用户已经确认过覆盖，因此这里直接写、不再二次确认。
/// 复制走 `fs::copy`，不让文件内容经 base64 绕一圈。
#[tauri::command]
pub async fn file_save_as(
    source: FileLocation,
    target_path: String,
) -> Result<FileTransferResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, from) = resolve_source(&source)?;
        let target = PathBuf::from(target_path.trim());
        if !target.is_absolute() {
            return Err("另存为的目标必须是绝对路径".to_string());
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建目录 {} 失败：{error}", parent.display()))?;
        }
        let bytes = fs::copy(&from, &target)
            .map_err(|error| format!("保存到 {} 失败：{error}", target.display()))?;
        Ok(FileTransferResult {
            path: target.display().to_string(),
            bytes,
        })
    })
    .await
    .map_err(|error| format!("另存为失败：{error}"))?
}

/// 读取一个文件的原始字节，以 base64 返回。
///
/// 二进制文件没法走 `workspace_read_file` 的文本通道（`read_to_string` 读不了 STEP），
/// 这里复用缓存侧同一套 base64，前端 `decodeBase64` 解出 `Uint8Array` 直接交给 WASM 解析。
#[tauri::command]
pub async fn file_read_bytes(source: FileLocation) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, target) = resolve_source(&source)?;
        let bytes = fs::read(&target)
            .map_err(|error| format!("读取 {} 失败：{error}", target.display()))?;
        Ok(cache::base64_encode(&bytes))
    })
    .await
    .map_err(|error| format!("读取文件失败：{error}"))?
}

/// 列出工作区某个目录下的文件（按最后写入时间倒序）。
///
/// 目录不存在视为「空」：`imports/` 是随用随建的，用户还没导入过任何图纸时不该报错。
#[tauri::command]
pub async fn workspace_list_dir(
    project_path: String,
    path: String,
) -> Result<Vec<DirEntryInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, target) = workspace::resolve_path(&project_path, &path, true)?;
        if !target.is_dir() {
            return Ok(Vec::new());
        }
        let entries = fs::read_dir(&target)
            .map_err(|error| format!("读取目录 {} 失败：{error}", target.display()))?;
        let mut out = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| format!("读取目录项失败：{error}"))?;
            let meta = entry
                .metadata()
                .map_err(|error| format!("读取文件信息失败：{error}"))?;
            if !meta.is_file() {
                continue;
            }
            let modified_at = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|elapsed| elapsed.as_secs())
                .unwrap_or(0);
            out.push(DirEntryInfo {
                name: entry.file_name().to_string_lossy().into_owned(),
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
    })
    .await
    .map_err(|error| format!("列出目录失败：{error}"))?
}

#[cfg(test)]
mod context_tests {
    use super::*;

    struct TestDirectory(PathBuf);
    impl TestDirectory {
/// 函数级说明（开发者 Jan）：执行 new 的单一职责，并返回可供调用方继续处理的结果。
        fn new() -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path =
                std::env::temp_dir().join(format!("octopuses-context-{}-{nonce}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDirectory {
/// 函数级说明（开发者 Jan）：执行 drop 的单一职责，并返回可供调用方继续处理的结果。
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
/// 函数级说明（开发者 Jan）：执行 resolves_relative_context_against_explicit_workspace 的单一职责，并返回可供调用方继续处理的结果。
    fn resolves_relative_context_against_explicit_workspace() {
        let dir = TestDirectory::new();
        let resolved = resolve_context_path("docs/report.pdf", dir.0.to_str()).unwrap();
        assert_eq!(resolved, dir.0.join("docs/report.pdf"));
        assert!(resolve_context_path("report.pdf", None).is_err());
        assert!(resolve_context_path("report.pdf", Some("relative-root")).is_err());
        assert_eq!(
            resolve_context_path(dir.0.to_str().unwrap(), None).unwrap(),
            dir.0
        );
    }

    #[test]
/// 函数级说明（开发者 Jan）：执行 expands_home_context_without_shell 的单一职责，并返回可供调用方继续处理的结果。
    fn expands_home_context_without_shell() {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            assert_eq!(
                resolve_context_path("~/docs/report.pdf", None).unwrap(),
                PathBuf::from(home).join("docs/report.pdf")
            );
        }
    }

    #[test]
/// 函数级说明（开发者 Jan）：执行 reads_context_as_bytes_and_preserves_literal_file_names 的单一职责，并返回可供调用方继续处理的结果。
    fn reads_context_as_bytes_and_preserves_literal_file_names() {
        let dir = TestDirectory::new();
        let path = dir.0.join("notes ' $script.txt");
        fs::write(&path, b"hello").unwrap();
        match read_context_path(&path).unwrap() {
            ContextPathData::File { name, encoded } => {
                assert_eq!(name, "notes ' $script.txt");
                assert_eq!(encoded, "aGVsbG8=");
            }
            _ => panic!("expected a file"),
        }
    }

    #[test]
/// 函数级说明（开发者 Jan）：执行 detects_directory_without_trailing_slash 的单一职责，并返回可供调用方继续处理的结果。
    fn detects_directory_without_trailing_slash() {
        let dir = TestDirectory::new();
        fs::create_dir(dir.0.join("docs")).unwrap();
        fs::write(dir.0.join("a.txt"), b"a").unwrap();
        match read_context_path(&dir.0).unwrap() {
            ContextPathData::Folder { entries, truncated } => {
                assert_eq!(entries, vec!["a.txt", "docs/"]);
                assert!(!truncated);
            }
            _ => panic!("expected a directory"),
        }
    }

    #[test]
/// 函数级说明（开发者 Jan）：执行 rejects_oversized_and_missing_context_files 的单一职责，并返回可供调用方继续处理的结果。
    fn rejects_oversized_and_missing_context_files() {
        let dir = TestDirectory::new();
        let path = dir.0.join("large.pdf");
        fs::File::create(&path)
            .unwrap()
            .set_len(MAX_CONTEXT_BYTES + 1)
            .unwrap();
        assert!(read_context_path(&path).err().unwrap().contains("10 MB"));
        assert!(read_context_path(&dir.0.join("missing.pdf")).is_err());
    }

    #[test]
/// 函数级说明（开发者 Jan）：执行 bounds_directory_entries_and_reports_truncation 的单一职责，并返回可供调用方继续处理的结果。
    fn bounds_directory_entries_and_reports_truncation() {
        let dir = TestDirectory::new();
        for index in 0..=MAX_CONTEXT_ENTRIES {
            fs::write(dir.0.join(format!("{index}.txt")), b"").unwrap();
        }
        match read_context_path(&dir.0).unwrap() {
            ContextPathData::Folder { entries, truncated } => {
                assert_eq!(entries.len(), MAX_CONTEXT_ENTRIES);
                assert!(truncated);
            }
            _ => panic!("expected a directory"),
        }
    }

    #[tokio::test]
    async fn configured_knowledge_limit_reaches_native_reader() {
        let dir = TestDirectory::new();
        let path = dir.0.join("large.md");
        fs::File::create(&path).unwrap().set_len(11 * 1024 * 1024).unwrap();
        let name = path.to_string_lossy().into_owned();
        assert!(context_read_path(name.clone(), None, None).await.err().unwrap().contains("10 MB"));
        assert!(matches!(context_read_path(name.clone(), None, Some(12)).await.unwrap(), ContextPathData::File { .. }));
        assert!(context_read_path(name.clone(), None, Some(1)).await.err().unwrap().contains("1 MB"));
        assert!(context_read_path(name.clone(), None, Some(0)).await.is_err());
        assert!(context_read_path(name, None, Some(201)).await.is_err());
        fs::File::create(&path).unwrap().set_len(1024 * 1024).unwrap();
        assert!(read_context_path_with_limit(&path, 1024 * 1024).is_ok());
    }
}
