//! 本地 JSON 配置文件的原子读写（开发者 Jan）。
//!
//! MCP 服务、远程主机这类本地配置都是「低频、小数据、无关联查询」的内容，
//! 统一用缓存目录下的 JSON 文件承载：不建表、不进 SQLite，读取即解析、写入即整文件替换。
//! 写入一律「先写同目录临时文件再改名」，保证任何时刻磁盘上要么是旧配置、要么是新配置，
//! 不会出现被截断的半个文件。

use std::fs;
use std::path::Path;

use serde::de::DeserializeOwned;
use serde::Serialize;

/// 原子写文本：先落临时文件，再改名替换目标文件（开发者 Jan）。
///
/// 临时文件必须与目标同目录——只有同一文件系统内的 `rename` 才是原子替换；
/// 临时名带进程号，避免多个实例同时写入时互相覆盖。
pub fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("配置路径无父目录：{}", path.display()))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("配置路径无文件名：{}", path.display()))?
        .to_string_lossy();
    let temp = parent.join(format!(".{file_name}.tmp-{}", std::process::id()));
    fs::write(&temp, contents).map_err(|error| format!("写入临时配置失败: {error}"))?;
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(format!("替换配置失败: {error}"));
    }
    Ok(())
}

/// 读取并反序列化 JSON 配置（开发者 Jan）。
///
/// 文件不存在或内容为空都视为「尚未配置」，返回 `None` 而不是报错，
/// 让调用方以默认空配置启动，而不是在首次使用时被一个不存在的文件绊住。
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(|error| format!("读取配置失败: {error}"))?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| format!("解析配置失败: {error}"))
}

/// 序列化并原子写回 JSON 配置（开发者 Jan）。
///
/// 保留缩进而非压成单行：这些配置是用户可读、可手工排查的本机文件。
// 允许 `?Sized`：调用方常直接传切片（如 `&[McpServer]`），切片本身没有固定大小
pub fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|error| format!("序列化配置失败: {error}"))?;
    write_atomic(path, &text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 每个用例独占的临时目录，避免相互干扰
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "octopuses-json-store-test-{}-{}",
            std::process::id(),
            name
        ));
        if dir.exists() {
            fs::remove_dir_all(&dir).expect("清理测试目录失败");
        }
        fs::create_dir_all(&dir).expect("创建测试目录失败");
        dir
    }

    #[test]
    fn write_atomic_replaces_existing_file() {
        let dir = scratch("replace");
        let file = dir.join("config.json");
        write_atomic(&file, "first").expect("首次写入失败");
        write_atomic(&file, "second").expect("覆盖写入失败");
        assert_eq!(fs::read_to_string(&file).expect("读取失败"), "second");
    }

    #[test]
    fn write_atomic_leaves_no_temp_file() {
        let dir = scratch("cleanup");
        let file = dir.join("config.json");
        write_atomic(&file, "content").expect("写入失败");
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .expect("列目录失败")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件：{leftovers:?}");
    }

    #[test]
    fn read_json_missing_file_is_none() {
        let dir = scratch("missing");
        let parsed: Option<Vec<String>> =
            read_json(&dir.join("absent.json")).expect("读取不存在的文件不应报错");
        assert!(parsed.is_none());
    }

    #[test]
    fn write_then_read_roundtrip() {
        let dir = scratch("roundtrip");
        let file = dir.join("config.json");
        write_json(&file, &vec!["a".to_string(), "b".to_string()]).expect("写入失败");
        let parsed: Option<Vec<String>> = read_json(&file).expect("读取失败");
        assert_eq!(parsed, Some(vec!["a".to_string(), "b".to_string()]));
    }
}
