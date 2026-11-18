//! Small, reviewable plugin packages: SKILL.md files and MCP declarations, without install scripts.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, HashSet}, fs, path::{Path, PathBuf}};
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PluginSkill { id: String, content: String }
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PluginManifest {
    id: String, name: String, version: String,
    #[serde(default)] skills: Vec<PluginSkill>,
    #[serde(default)] mcp: Vec<Value>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin { id: String, name: String, version: String, source: String, files: BTreeMap<String, String>, mcp_ids: Vec<String> }
/// Limit resource identifiers to names safe for namespaced cache paths.
fn safe_id(id: &str) -> bool { !id.is_empty() && id.len() <= 80 && id.bytes().all(|v| v.is_ascii_alphanumeric() || v == b'-' || v == b'_') }
/// Fingerprint installed bytes so updates cannot silently overwrite local edits.
fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
/// Load plugin ownership metadata from the selected cache.
fn registry(root: &Path) -> Result<Vec<InstalledPlugin>, String> {
    match fs::read(root.join("plugins/installed.json")) { Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]), Err(e) => Err(e.to_string()) }
}
/// Check that a recorded path belongs to the expected plugin namespace.
fn owned(id: &str, relative: &str) -> bool {
    let parts = relative.split('/').collect::<Vec<_>>();
    parts.len() == 3 && parts[0] == "skills" && parts[1].starts_with(&format!("{id}--")) && safe_id(parts[1]) && parts[2] == "SKILL.md"
}
/// Apply one rooted atomic file write or deletion for a plugin transaction.
fn write(root: &Path, path: &Path, value: Option<&[u8]>) -> Result<(), String> {
    if let Some(value) = value {
        let parent = path.parent().ok_or("插件路径无效")?; fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        if !fs::canonicalize(parent).map_err(|e| e.to_string())?.starts_with(root) { return Err("插件目录不能指向缓存外部".into()); }
        if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) { return Err("插件文件不能是符号链接".into()); }
        fs::write(path, value).map_err(|e| e.to_string())
    } else { match fs::remove_file(path) { Ok(()) => Ok(()), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()), Err(e) => Err(e.to_string()) } }
}
/// Validate ownership, capture every backup, then apply or roll back resource changes.
fn install(root: &Path, manifest: Option<PluginManifest>, id: &str, source: &str) -> Result<Vec<InstalledPlugin>, String> {
    if !safe_id(id) { return Err("插件 ID 无效".into()); }
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let mut installed = registry(&root)?; let previous = installed.iter().find(|v| v.id == id).cloned();
    if manifest.is_none() && previous.is_none() { return Err("插件未安装".into()); }
    if let Some(old) = &previous {
        for (relative, expected) in &old.files {
            if !owned(id, relative) { return Err("插件所有权记录无效".into()); }
            let bytes = fs::read(root.join(relative)).map_err(|e| e.to_string())?;
            if digest(&bytes) != *expected { return Err(format!("{relative} 已被修改，请先备份或迁出后再更新／卸载")); }
        }
    }
    let mut servers = crate::mcp::load(&root)?;
    if let Some(old) = &previous { servers.retain(|s| !old.mcp_ids.contains(&s.id)); }
    let mut resources: BTreeMap<String, Vec<u8>> = BTreeMap::new(); let mut mcp_ids = Vec::new();
    if let Some(m) = &manifest {
        if m.id != id || m.name.trim().is_empty() || m.version.is_empty() || m.skills.len() > 32 || m.mcp.len() > 32 { return Err("插件元数据无效或资源过多".into()); }
        for skill in &m.skills {
            if !safe_id(&skill.id) || skill.content.len() > 256000 || !skill.content.starts_with("---") { return Err("技能 ID、大小或 SKILL.md 格式无效".into()); }
            let relative = format!("skills/{id}--{}/SKILL.md", skill.id);
            if !owned(id, &relative) || resources.contains_key(&relative) { return Err("插件技能 ID 重复或过长".into()); }
            if root.join(&relative).exists() && !previous.as_ref().is_some_and(|p| p.files.contains_key(&relative)) { return Err(format!("不能覆盖已有技能：{relative}")); }
            resources.insert(relative, skill.content.as_bytes().to_vec());
        }
        let mut seen = HashSet::new();
        for value in &m.mcp {
            let mut server: crate::mcp::McpServer = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
            if !safe_id(&server.id) || server.name.trim().is_empty() || server.command.trim().is_empty() { return Err("MCP 声明无效".into()); }
            server.id = format!("{id}--{}", server.id); server.enabled = false;
            if !safe_id(&server.id) || !seen.insert(server.id.clone()) || servers.iter().any(|s| s.id == server.id) { return Err("插件 MCP ID 冲突".into()); }
            mcp_ids.push(server.id.clone()); servers.push(server);
        }
    }
    let mut changes: BTreeMap<PathBuf, Option<Vec<u8>>> = BTreeMap::new();
    if let Some(old) = &previous { for relative in old.files.keys() { changes.insert(root.join(relative), None); } }
    for (relative, content) in &resources { changes.insert(root.join(relative), Some(content.clone())); }
    installed.retain(|p| p.id != id);
    if let Some(m) = manifest { installed.push(InstalledPlugin { id: m.id, name: m.name, version: m.version, source: source.into(), files: resources.iter().map(|(p,b)| (p.clone(), digest(b))).collect(), mcp_ids }); }
    changes.insert(root.join("mcp/servers.json"), Some(serde_json::to_vec_pretty(&servers).map_err(|e| e.to_string())?));
    changes.insert(root.join("plugins/installed.json"), Some(serde_json::to_vec_pretty(&installed).map_err(|e| e.to_string())?));
    let mut backups = Vec::new();
    for path in changes.keys() {
        if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) { return Err("插件资源不能是符号链接".into()); }
        let old = match fs::read(path) { Ok(v) => Some(v), Err(e) if e.kind() == std::io::ErrorKind::NotFound => None, Err(e) => return Err(e.to_string()) };
        backups.push((path.clone(), old));
    }
    for (path, contents) in changes {
        if let Err(error) = write(&root, &path, contents.as_deref()) {
            let mut failures = Vec::new();
            for (path, old) in backups.into_iter().rev() { if let Err(e) = write(&root, &path, old.as_deref()) { failures.push(e); } }
            return Err(format!("插件操作失败：{error}；恢复结果：{}", if failures.is_empty() { "已恢复原文件".into() } else { failures.join("；") }));
        }
    }
    Ok(installed)
}
#[tauri::command]
/// Expose installed plugin metadata to the preferences interface.
pub fn plugins_list(cache_path: String) -> Result<Vec<InstalledPlugin>, String> { registry(Path::new(&cache_path)) }
#[tauri::command]
/// Fetch a bounded HTTPS manifest without redirects or URL credentials.
pub async fn plugins_fetch(url: String) -> Result<Value, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() { return Err("插件源须使用 HTTPS，不能在 URL 中携带凭据".into()); }
    let response = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(30)).build().map_err(|e| e.to_string())?.get(parsed).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() { return Err(format!("插件源 HTTP {}", response.status())); }
    use futures::StreamExt;
    let mut stream = response.bytes_stream(); let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await { let chunk = chunk.map_err(|e| e.to_string())?; if bytes.len() + chunk.len() > 2 * 1024 * 1024 { return Err("插件清单超过 2 MB".into()); } bytes.extend_from_slice(&chunk); }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
#[tauri::command]
/// Run the plugin transaction outside the WebView event loop.
pub async fn plugins_install(cache_path: String, manifest: PluginManifest, source: String) -> Result<Vec<InstalledPlugin>, String> {
    tauri::async_runtime::spawn_blocking(move || { let id = manifest.id.clone(); install(Path::new(&cache_path), Some(manifest), &id, &source) }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
/// Remove only unchanged resources owned by the selected installed plugin.
pub async fn plugins_uninstall(cache_path: String, id: String) -> Result<Vec<InstalledPlugin>, String> {
    tauri::async_runtime::spawn_blocking(move || install(Path::new(&cache_path), None, &id, "")).await.map_err(|e| e.to_string())?
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn install_update_uninstall_and_protect_local_edits() {
        let root = tempfile::tempdir().unwrap();
        let manifest = PluginManifest { id: "example".into(), name: "Example".into(), version: "1".into(), skills: vec![PluginSkill { id: "test".into(), content: "---\nname: test\ndescription: example\n---\nDo work".into() }], mcp: vec![] };
        assert_eq!(install(root.path(), Some(manifest.clone()), "example", "https://example.invalid").unwrap().len(), 1);
        fs::write(root.path().join("skills/example--test/SKILL.md"), "local edit").unwrap();
        assert!(install(root.path(), None, "example", "").unwrap_err().contains("已被修改"));
        fs::write(root.path().join("skills/example--test/SKILL.md"), &manifest.skills[0].content).unwrap();
        assert!(install(root.path(), None, "example", "").unwrap().is_empty());
    }
    #[test] fn reject_paths_and_unowned_resources() { assert!(!safe_id("../escape")); assert!(!owned("pkg", "skills/pkg--x/../../config")); }
}
