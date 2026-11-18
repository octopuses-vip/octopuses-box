//! Separate browser WebView without filesystem/IPC capabilities. Explicit selections become data.
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use serde_json::json;
const ANNOTATE: &str = r#"
addEventListener('DOMContentLoaded', () => {
  const button = document.createElement('button'); button.textContent = '引用选中内容到 octopuses';
  Object.assign(button.style, { position:'fixed',right:'14px',bottom:'14px',zIndex:'2147483647',padding:'10px',background:'#14687a',color:'white',border:'0',borderRadius:'8px' });
  button.addEventListener('click', () => {
    const text = getSelection()?.toString().slice(0,8000); if (!text) { alert('请先选中要引用的文字'); return; }
    location.href = 'octopuses-annotation://selection?' + new URLSearchParams({ text, title:document.title.slice(0,300), url:location.href });
  }); document.documentElement.append(button);
});
"#;
#[tauri::command]
/// Open an HTTP(S)-only preview with selection forwarding and no local IPC capabilities.
pub async fn browser_preview_open(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "https" | "http") || !parsed.username().is_empty() || parsed.password().is_some() { return Err("仅支持不带账号密码的 HTTP/HTTPS 页面".into()); }
    if let Some(window) = app.get_webview_window("browser-preview") { window.close().map_err(|e| e.to_string())?; }
    let handle = app.clone();
    WebviewWindowBuilder::new(&app, "browser-preview", WebviewUrl::External(parsed))
        .title("octopuses 浏览器预览").inner_size(1200.0, 800.0).initialization_script(ANNOTATE)
        .on_navigation(move |url| {
            if url.scheme() == "octopuses-annotation" {
                let fields: std::collections::HashMap<_, _> = url.query_pairs().map(|(k,v)| (k.into_owned(), v.into_owned())).collect();
                if let Some(text) = fields.get("text").filter(|v| v.len() <= 32000) {
                    let _ = handle.emit("browser-annotation", json!({ "text": text, "title": fields.get("title"), "url": fields.get("url") }));
                }
                return false;
            }
            matches!(url.scheme(), "http" | "https" | "about")
        }).build().map_err(|e| e.to_string())?;
    Ok(())
}
