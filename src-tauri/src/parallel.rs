//! 多项目并行任务的批次档案。
//!
//! 「把一条任务同时分发给多个项目」在界面上表现为一个批次（batch）：批次记录任务提示词、
//! 创建时间，以及每个项目对应的一次运行（项目 + 会话 + 状态 + 收尾信息）。真正驱动运行的是
//! 前端的按会话并行队列（见 `src/hooks/useAgentRun.ts`），后端只负责把批次档案可靠地落到
//! 缓存目录下的 `parallel/batches.json`，供重启后回看「哪条任务发给了哪些项目、各自跑成什么样」。
//!
//! 因此这里不做任何进程与网络操作，只有配置读写：读取容错、写入原子、同一 id 覆盖。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 批次配置目录（相对缓存目录）与档案文件
const PARALLEL_DIR: &str = "parallel";
const BATCHES_FILE: &str = "batches.json";
/// 本地保留的批次数上限，超出后丢弃最旧的批次
const BATCH_LIMIT: usize = 50;

/// 批次里的一个项目运行条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParallelItem {
    /// 目标项目 id
    pub project_id: String,
    /// 项目名快照：项目被改名或删除后，历史批次仍能辨认当初发去了哪
    pub project_name: String,
    /// 该项目本次运行所在的会话 id，可跳转查看
    pub thread_id: String,
    /// 运行状态：`queued` / `running` / `success` / `failed` / `aborted`
    #[serde(default = "default_status")]
    pub status: String,
    /// 失败原因，成功或未结束时为 null
    #[serde(default)]
    pub error: Option<String>,
    /// 结束时间（Unix 毫秒），未结束为 null
    #[serde(default)]
    pub finished_at: Option<i64>,
}

/// 状态缺省为排队中：旧档案或手工改动的条目也能被正常读回
fn default_status() -> String {
    "queued".to_string()
}

/// 一个并行任务批次
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParallelBatch {
    /// 批次 id
    pub id: String,
    /// 分发给各项目的任务提示词
    pub prompt: String,
    /// 创建时间（Unix 毫秒），列表按此倒序
    pub created_at: i64,
    /// 各项目的运行条目
    #[serde(default)]
    pub items: Vec<ParallelItem>,
}

/// 批次档案目录，不存在时创建
fn parallel_root(cache_dir: &Path) -> Result<PathBuf, String> {
    let root = cache_dir.join(PARALLEL_DIR);
    fs::create_dir_all(&root).map_err(|error| format!("创建并行任务目录失败: {error}"))?;
    Ok(root)
}

/// 读取全部批次；文件不存在或为空时视为没有批次
pub fn load(cache_dir: &Path) -> Result<Vec<ParallelBatch>, String> {
    let file = parallel_root(cache_dir)?.join(BATCHES_FILE);
    if !file.is_file() {
        return Ok(Vec::new());
    }
    let text =
        fs::read_to_string(&file).map_err(|error| format!("读取并行任务档案失败: {error}"))?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&text).map_err(|error| format!("解析并行任务档案失败: {error}"))
}

/// 原子写批次档案
fn store(cache_dir: &Path, batches: &[ParallelBatch]) -> Result<(), String> {
    let root = parallel_root(cache_dir)?;
    let text = serde_json::to_string_pretty(batches)
        .map_err(|error| format!("序列化并行任务档案失败: {error}"))?;
    write_atomic(&root.join(BATCHES_FILE), &text)
}

/// 原子写：先写临时文件再改名，避免中途失败留下半个档案
fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "并行任务档案路径无父目录。".to_string())?;
    let temp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name().unwrap().to_string_lossy(),
        std::process::id()
    ));
    fs::write(&temp, contents).map_err(|error| format!("写入临时档案失败: {error}"))?;
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(format!("替换并行任务档案失败: {error}"));
    }
    Ok(())
}

/// 校验批次：id 与提示词非空、至少有一个项目条目
fn validate(batch: &ParallelBatch) -> Result<(), String> {
    if batch.id.trim().is_empty() {
        return Err("并行任务批次 id 不能为空。".to_string());
    }
    if batch.prompt.trim().is_empty() {
        return Err("并行任务提示词不能为空。".to_string());
    }
    if batch.items.is_empty() {
        return Err("并行任务至少需要一个项目。".to_string());
    }
    for item in &batch.items {
        if item.project_id.trim().is_empty() || item.thread_id.trim().is_empty() {
            return Err("并行任务条目的项目 id 与会话 id 不能为空。".to_string());
        }
    }
    Ok(())
}

/// 新增或更新一个批次：按 id 覆盖，返回按创建时间倒序的完整档案
pub fn save(cache_dir: &Path, batch: ParallelBatch) -> Result<Vec<ParallelBatch>, String> {
    validate(&batch)?;
    let mut batches = load(cache_dir)?;
    match batches.iter().position(|item| item.id == batch.id) {
        Some(index) => batches[index] = batch,
        None => batches.push(batch),
    }
    // 新的在前；同一毫秒创建时以 id 兜底，保证顺序稳定
    batches.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| right.id.cmp(&left.id))
    });
    batches.truncate(BATCH_LIMIT);
    store(cache_dir, &batches)?;
    Ok(batches)
}

/// 删除一个批次；不存在时报错，不做静默成功
pub fn delete(cache_dir: &Path, batch_id: &str) -> Result<Vec<ParallelBatch>, String> {
    let id = batch_id.trim();
    if id.is_empty() {
        return Err("并行任务批次 id 不能为空。".to_string());
    }
    let mut batches = load(cache_dir)?;
    let before = batches.len();
    batches.retain(|batch| batch.id != id);
    if batches.len() == before {
        return Err(format!("并行任务批次不存在：{id}"));
    }
    store(cache_dir, &batches)?;
    Ok(batches)
}

/// 读取并行任务批次（开发者 Jan）：文件不存在时返回空列表
#[tauri::command]
pub fn parallel_list_batches(cache_dir: String) -> Result<Vec<ParallelBatch>, String> {
    load(Path::new(&cache_dir))
}

/// 保存一个并行任务批次（开发者 Jan）：按 id 覆盖式 upsert，并只保留最近若干条，
/// 避免批次文件无限膨胀；id 不存在时视为新增。
#[tauri::command]
pub fn parallel_save_batch(
    cache_dir: String,
    batch: ParallelBatch,
) -> Result<Vec<ParallelBatch>, String> {
    save(Path::new(&cache_dir), batch)
}

/// 删除一个并行任务批次（开发者 Jan）：id 不存在时报错，避免「以为删掉了其实没删」
#[tauri::command]
pub fn parallel_delete_batch(
    cache_dir: String,
    batch_id: String,
) -> Result<Vec<ParallelBatch>, String> {
    delete(Path::new(&cache_dir), &batch_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "octopuses-parallel-test-{}-{}",
            std::process::id(),
            name
        ));
        if dir.exists() {
            fs::remove_dir_all(&dir).expect("清理测试目录失败");
        }
        fs::create_dir_all(&dir).expect("创建测试目录失败");
        dir
    }

    fn batch(id: &str, created_at: i64) -> ParallelBatch {
        ParallelBatch {
            id: id.to_string(),
            prompt: "整理本周提交记录".to_string(),
            created_at,
            items: vec![ParallelItem {
                project_id: "proj-a".to_string(),
                project_name: "项目 A".to_string(),
                thread_id: format!("thread-{id}"),
                status: "queued".to_string(),
                error: None,
                finished_at: None,
            }],
        }
    }

    #[test]
    fn load_missing_file_returns_empty_and_save_roundtrips() {
        let cache = scratch("roundtrip");
        assert!(load(&cache).unwrap().is_empty());
        let batches = save(&cache, batch("b1", 100)).unwrap();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].prompt, "整理本周提交记录");
        assert_eq!(batches[0].items[0].project_name, "项目 A");

        let reloaded = load(&cache).unwrap();
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded[0].id, "b1");
        assert_eq!(reloaded[0].items[0].status, "queued");
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn save_upserts_by_id_and_orders_newest_first() {
        let cache = scratch("upsert");
        save(&cache, batch("b1", 100)).unwrap();
        save(&cache, batch("b2", 200)).unwrap();
        let mut updated = batch("b1", 100);
        updated.items[0].status = "success".to_string();
        updated.items[0].finished_at = Some(300);
        let batches = save(&cache, updated).unwrap();
        // 覆盖而非追加，且按创建时间倒序
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].id, "b2");
        assert_eq!(batches[1].id, "b1");
        assert_eq!(batches[1].items[0].status, "success");
        assert_eq!(batches[1].items[0].finished_at, Some(300));
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn save_rejects_invalid_batches() {
        let cache = scratch("invalid");
        let mut blank_id = batch("b1", 100);
        blank_id.id = "  ".to_string();
        assert!(save(&cache, blank_id).unwrap_err().contains("id"));

        let mut blank_prompt = batch("b1", 100);
        blank_prompt.prompt = "".to_string();
        assert!(save(&cache, blank_prompt).unwrap_err().contains("提示词"));

        let mut no_items = batch("b1", 100);
        no_items.items.clear();
        assert!(save(&cache, no_items).unwrap_err().contains("项目"));
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn delete_removes_batch_and_rejects_missing() {
        let cache = scratch("delete");
        save(&cache, batch("b1", 100)).unwrap();
        save(&cache, batch("b2", 200)).unwrap();
        let batches = delete(&cache, "b1").unwrap();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].id, "b2");
        assert!(delete(&cache, "b1").unwrap_err().contains("不存在"));
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn keeps_only_latest_batches() {
        let cache = scratch("limit");
        for index in 0..(BATCH_LIMIT + 5) {
            save(&cache, batch(&format!("b{index}"), index as i64)).unwrap();
        }
        let batches = load(&cache).unwrap();
        assert_eq!(batches.len(), BATCH_LIMIT);
        // 最旧的已被丢弃，最新的一条在最前
        assert_eq!(batches[0].id, format!("b{}", BATCH_LIMIT + 4));
        assert!(!batches.iter().any(|item| item.id == "b0"));
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn tolerates_missing_optional_fields_on_read() {
        // 手工改动或旧档案可能缺少可选字段，读取侧应给出安全缺省而不是整体失败
        let cache = scratch("tolerant");
        let root = parallel_root(&cache).unwrap();
        fs::write(
            root.join(BATCHES_FILE),
            r#"[{"id":"b1","prompt":"p","createdAt":1,"items":[{"projectId":"proj-a","projectName":"A","threadId":"t1"}]}]"#,
        )
        .unwrap();
        let batches = load(&cache).unwrap();
        assert_eq!(batches[0].items[0].status, "queued");
        assert_eq!(batches[0].items[0].error, None);
        assert_eq!(batches[0].items[0].finished_at, None);
        fs::remove_dir_all(&cache).ok();
    }
}
