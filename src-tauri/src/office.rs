//! Render Office files with a disposable LibreOffice profile; source files are never changed.
use std::{fs, path::{Path, Component}, process::{Command, Stdio}, time::{Duration, Instant}};
/// Convert a bounded copy using a disposable profile, leaving the source unchanged.
fn render(dir: &Path, name: &str) -> Result<Vec<u8>, String> {
    let directory = fs::canonicalize(dir).map_err(|e| e.to_string())?;
    if Path::new(name).components().any(|p| !matches!(p, Component::Normal(_))) { return Err("Office 文件路径无效".into()); }
    let source = fs::canonicalize(directory.join(name)).map_err(|e| e.to_string())?;
    if !source.starts_with(&directory) { return Err("Office 文件越过目录边界".into()); }
    let extension = source.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
    if !["docx", "xlsx", "pptx", "odt", "ods", "odp"].contains(&extension.as_str()) { return Err("不支持此 Office 文件格式".into()); }
    if fs::metadata(&source).map_err(|e| e.to_string())?.len() > 128 * 1024 * 1024 { return Err("Office 预览文件超过 128 MB，请拆分后查看".into()); }
    let bytes = fs::read(&source).map_err(|e| e.to_string())?;
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let input = temp.path().join(format!("document.{extension}")); fs::write(&input, bytes).map_err(|e| e.to_string())?;
    let profile = temp.path().join("profile"); fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    fs::write(profile.join("registrymodifications.xcu"), r#"<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateDocMode" oor:op="fuse"><value>0</value></prop></item></oor:items>"#).map_err(|e| e.to_string())?;
    let profile_url = reqwest::Url::from_directory_path(&profile).map_err(|_| "无法解析预览配置路径")?;
    let binary = if cfg!(target_os = "macos") && Path::new("/Applications/LibreOffice.app/Contents/MacOS/soffice").is_file() { "/Applications/LibreOffice.app/Contents/MacOS/soffice" } else if cfg!(windows) { "soffice.exe" } else { "soffice" };
    let mut command = Command::new(binary);
    command.arg(format!("-env:UserInstallation={profile_url}")).args(["--headless", "--nologo", "--nodefault", "--nofirststartwizard", "--convert-to", "pdf", "--outdir"]).arg(temp.path()).arg(&input).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    crate::platform::hide_console(&mut command);
    let mut child = command.spawn().map_err(|e| format!("Office 版式预览需要安装 LibreOffice 并将 soffice 加入 PATH：{e}"))?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { if !status.success() { return Err("Office 转换失败，请检查文档是否损坏或受密码保护".into()); } break; }
        if start.elapsed() > Duration::from_secs(90) { let _ = child.kill(); let _ = child.wait(); return Err("Office 预览转换超过 90 秒".into()); }
        std::thread::sleep(Duration::from_millis(100));
    }
    let pdf = fs::read(temp.path().join("document.pdf")).map_err(|_| "LibreOffice 没有生成 PDF，请确认格式受支持且文档无需密码")?;
    if pdf.len() > 64 * 1024 * 1024 || !pdf.starts_with(b"%PDF-") { return Err("转换结果无效或 PDF 超过 64 MB".into()); }
    Ok(pdf)
}
#[tauri::command]
/// Move document conversion off the desktop event loop.
pub async fn office_render(directory: String, name: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || render(Path::new(&directory), &name)).await.map_err(|e| e.to_string())?
}

#[cfg(test)] mod tests {
    use super::*;
    #[test]
    #[ignore = "requires a local LibreOffice installation"]
    fn renders_real_office_document_without_changing_source() {
        let root = tempfile::tempdir().unwrap();
        let bytes = include_bytes!("../../tests/fixtures/office-preview.docx");
        fs::write(root.path().join("preview.docx"), bytes).unwrap();
        let pdf = render(root.path(), "preview.docx").unwrap();
        assert!(pdf.starts_with(b"%PDF-")); assert!(pdf.len() > 1000);
        assert_eq!(fs::read(root.path().join("preview.docx")).unwrap(), bytes);
        if let Ok(path) = std::env::var("OCTOPUSES_OFFICE_TEST_PDF") { fs::write(path, pdf).unwrap(); }
    }
}
