use std::path::Path;

use tauri::AppHandle;
use tauri::Manager;

use super::artifacts::*;
use super::base64::*;
use super::layout::*;

/// 系统默认缓存路径：`~/octopuses`（用户主目录下，三平台一致直观）
#[tauri::command]
pub fn cache_default_dir(app: AppHandle) -> Result<String, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法获取用户主目录: {error}"))?;
    Ok(home.join("octopuses").to_string_lossy().into_owned())
}

/// 初始化缓存目录（开发者 Jan）：补齐全部固定子目录并返回统计信息
#[tauri::command]
pub fn cache_init(path: String) -> Result<CacheInfo, String> {
    init(Path::new(&path))
}

/// 读取缓存目录的路径、子目录统计与创建时间（开发者 Jan）
#[tauri::command]
pub fn cache_info(path: String) -> Result<CacheInfo, String> {
    info(Path::new(&path))
}

/// 覆盖写入一个缓存文件（开发者 Jan）：相对路径由后端校验，拒绝写到缓存目录之外
#[tauri::command]
pub fn cache_write(
    path: String,
    relative: String,
    contents: String,
) -> Result<CacheFileInfo, String> {
    write_file(Path::new(&path), &relative, &contents)
}

/// 追加写入一个缓存文件（开发者 Jan）：用于日志这类持续追加的内容，保留已有部分
#[tauri::command]
pub fn cache_append(
    path: String,
    relative: String,
    contents: String,
) -> Result<CacheFileInfo, String> {
    append_file(Path::new(&path), &relative, &contents)
}

/// 读取一个缓存文件（开发者 Jan）：路径校验与写入共用同一套规则
#[tauri::command]
pub fn cache_read(path: String, relative: String) -> Result<String, String> {
    read_file(Path::new(&path), &relative)
}

/// 清理缓存（开发者 Jan）：scope 指定清理范围（如 temp），未知范围会被拒绝
#[tauri::command]
pub fn cache_clear(path: String, scope: String) -> Result<CacheInfo, String> {
    clear(Path::new(&path), &scope)
}

/// 写入文本产物（开发者 Jan）：目录由前端给出（项目 `output/` 或缓存 `outputs/<日期>/`），
/// 产物名只允许单层文件名，防止借产物名越出该目录
#[tauri::command]
pub fn artifact_write(
    dir: String,
    name: String,
    contents: String,
) -> Result<ArtifactWriteResult, String> {
    write_artifact(Path::new(&dir), &name, &contents)
}

/// 读取文本产物（开发者 Jan）：供「文件」tab 的富预览取原文
#[tauri::command]
pub fn artifact_read(dir: String, name: String) -> Result<String, String> {
    read_artifact(Path::new(&dir), &name)
}

/// 写入二进制产物：`data` 为 base64 编码的文件内容（前端从图像接口直接拿到 base64，无需二次编码）
#[tauri::command]
pub fn artifact_write_bytes(
    dir: String,
    name: String,
    data: String,
) -> Result<ArtifactWriteResult, String> {
    let bytes = base64_decode(&data)?;
    write_artifact_bytes(Path::new(&dir), &name, &bytes)
}

/// 读取二进制产物：返回 base64 编码的文件内容，前端解成 Blob 供 `<img>` / `<iframe>` 预览
#[tauri::command]
pub fn artifact_read_bytes(dir: String, name: String) -> Result<String, String> {
    let bytes = read_artifact_bytes(Path::new(&dir), &name)?;
    Ok(base64_encode(&bytes))
}

/// 列出目标目录下的全部产物（开发者 Jan）：目录不存在时返回空列表，首次进入会话不报错
#[tauri::command]
pub fn artifact_list(dir: String) -> Result<Vec<ArtifactInfo>, String> {
    list_artifacts(Path::new(&dir))
}

/// 准备产物目录（开发者 Jan）：建目录，并按需在项目 `.gitignore` 里补一行忽略规则
#[tauri::command]
pub fn artifact_prepare_dir(
    dir: String,
    gitignore: Option<String>,
    entry: Option<String>,
) -> Result<(), String> {
    prepare_dir(
        Path::new(&dir),
        gitignore.as_deref().map(Path::new),
        entry.as_deref(),
    )
}

/// 迁移旧版共享产物目录（开发者 Jan）：按前端算好的归属把 `<缓存>/artifacts/` 里的历史产物搬回各会话目录
#[tauri::command]
pub fn artifact_migrate_legacy(
    cache_dir: String,
    targets: Vec<ArtifactMigrationTarget>,
) -> Result<ArtifactMigrationResult, String> {
    migrate_legacy(Path::new(&cache_dir), &targets)
}
