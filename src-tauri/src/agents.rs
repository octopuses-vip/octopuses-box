//! Agent（子代理）扫描与索引及本地生命周期管理。
//!
//! 与技能（`skills.rs`）同构：每个 agent 是一个目录 `<缓存目录>/agents/<agentId>/AGENT.md`。
//! `AGENT.md` 头部是 frontmatter（名称、说明、指定模型、工具白名单、权限档上限），
//! 正文是要注入系统提示的 persona。索引写入 `<缓存目录>/AGENTS.md`，供界面与模型了解有哪些 agent。
//!
//! 与技能不同的是：agent 不做「导入目录」，只提供扫描 / 新建 / 更新 / 删除四件事。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const AGENTS_DIR: &str = "agents";
const INDEX_FILE: &str = "AGENTS.md";
const AGENT_FILE: &str = "AGENT.md";

/// 一个 agent 的元信息（前端列表与运行收口都用它）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    /// 目录名，作为 agent 唯一标识
    id: String,
    name: String,
    description: String,
    /// 指定模型 code；空串表示跟随会话当前模型
    model: String,
    /// 工具白名单：类别键 / 单个工具名 / `*`；空数组表示不限制（全量工具）
    tools: Vec<String>,
    /// 权限档上限：ask / auto-readonly / auto-all；空串表示不限制
    permission_mode: String,
    /// 注入系统提示的 persona 正文（AGENT.md 正文部分）
    system_append: String,
    /// AGENT.md 绝对路径
    path: String,
}

/// 新建 agent 入参。
///
/// 注意：Tauri 只对命令顶层参数名做 camelCase 转换，嵌套结构体字段走标准 serde，
/// 因此这里必须显式声明 `rename_all = "camelCase"`，否则前端传来的 `permissionMode` 等键匹配不上。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentInput {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    tools: Vec<String>,
    #[serde(default)]
    permission_mode: String,
    #[serde(default)]
    system_append: String,
    overwrite: bool,
}

/// 更新 agent 入参：`original_id` 用于支持改 id（改名目录）。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAgentInput {
    original_id: String,
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    tools: Vec<String>,
    #[serde(default)]
    permission_mode: String,
    #[serde(default)]
    system_append: String,
    overwrite: bool,
}

/// 删除 agent 入参。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAgentInput {
    id: String,
}

/// 从 AGENT.md 解析出的 frontmatter 字段与正文。
#[derive(Default)]
struct AgentFrontmatter {
    name: Option<String>,
    description: Option<String>,
    model: Option<String>,
    tools: Option<Vec<String>>,
    permission_mode: Option<String>,
    body: String,
}

/// 把 `tools:` 的值拆成白名单（开发者 Jan）。
///
/// 支持逗号分隔（`workspace, ssh, read_file`）与裸 `*`（表示全量）；空值返回空数组。
/// 每个条目去空白、丢空串，后续由前端按「类别键 / 单个工具名 / `*`」解释。
fn parse_tools(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(|item| item.to_string())
        .collect()
}

/// 从 AGENT.md 解析 frontmatter 与正文（开发者 Jan），缺失字段留空。
///
/// 只认以 `---` 开头、并以另一行 `---` 收尾的 frontmatter 块；没有这个头就整份当作正文，
/// 因此手写笔记式的 AGENT.md 也不会被误解析。同名键只取第一次出现，后面的重复键不覆盖。
fn parse_frontmatter(text: &str) -> AgentFrontmatter {
    match crate::frontmatter::parse(text, &["name", "description", "model", "tools", "permissionMode"]) {
        Ok(mut parsed) => AgentFrontmatter {
            name: parsed.fields.remove("name"),
            description: parsed.fields.remove("description"),
            model: parsed.fields.remove("model"),
            tools: parsed.fields.remove("tools").map(|value| parse_tools(&value)),
            permission_mode: parsed.fields.remove("permissionMode"),
            body: parsed.body.trim().to_string(),
        },
        Err(error) => {
            let diagnostic = format!("Agent frontmatter 解析失败：{error}");
            crate::trace::write(&diagnostic);
            AgentFrontmatter {
                description: Some(diagnostic),
                body: text.trim().to_string(),
                ..Default::default()
            }
        }
    }
}

/// 扫描一个 agent 根目录下的全部 agent（开发者 Jan），按名称排序返回。
///
/// 只认「目录 + 目录内 AGENT.md 是普通文件」的结构：AGENT.md 是软链的目录直接跳过，
/// 避免 agent 内容被指向工作区外的文件。名称缺失时退回目录名；读不出的文件整条跳过。
fn scan_root(root: &Path) -> Vec<AgentInfo> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() || dir.join(AGENT_FILE).is_symlink() {
            continue;
        }
        let file = dir.join(AGENT_FILE);
        if !file.is_file() {
            continue;
        }
        let body = match fs::read_to_string(&file) {
            Ok(body) => body,
            Err(_) => continue,
        };
        let dir_name = dir
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        if dir_name.is_empty() {
            continue;
        }
        let parsed = parse_frontmatter(&body);
        found.push(AgentInfo {
            id: dir_name.clone(),
            name: parsed
                .name
                .filter(|value| !value.is_empty())
                .unwrap_or(dir_name),
            description: parsed.description.unwrap_or_default(),
            model: parsed.model.unwrap_or_default(),
            tools: parsed.tools.unwrap_or_default(),
            permission_mode: parsed.permission_mode.unwrap_or_default(),
            system_append: parsed.body,
            path: file.to_string_lossy().into_owned(),
        });
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

/// 渲染 agent 索引 AGENTS.md（开发者 Jan）：列出每个 agent 的名称、说明、工具与模型。
///
/// 索引是模型了解「有哪些 agent 可用」的入口，因此正文不写进索引——persona 可能很长，
/// 全部塞进系统提示会挤占上下文。没有 agent 时也写一份占位说明，避免模型看到空文件后反复重试。
fn render_index(agents: &[AgentInfo]) -> String {
    if agents.is_empty() {
        return "# Agent 目录\n\n当前没有可用 Agent。\n".to_string();
    }
    let mut lines = vec![
        "# Agent 目录".to_string(),
        String::new(),
        format!("共 {} 个可用 Agent。", agents.len()),
        String::new(),
    ];
    for agent in agents {
        lines.push(format!("## {}", agent.name));
        lines.push(format!(
            "- 说明：{}",
            if agent.description.is_empty() {
                "（无说明）"
            } else {
                agent.description.as_str()
            }
        ));
        lines.push(format!(
            "- 工具：{}",
            if agent.tools.is_empty() {
                "全部".to_string()
            } else {
                agent.tools.join("、")
            }
        ));
        lines.push(format!(
            "- 模型：{}",
            if agent.model.is_empty() {
                "跟随会话"
            } else {
                agent.model.as_str()
            }
        ));
        lines.push(format!("- 路径：{AGENTS_DIR}/{}/AGENT.md", agent.id));
        lines.push(String::new());
    }
    lines.join("\n")
}

/// 扫描 agent 目录并刷新索引（开发者 Jan），返回最新 agent 列表。
///
/// 每次调用都会重建 AGENTS.md：agent 可能被用户直接改文件系统，索引必须与目录现状一致，
/// 因此不做缓存。目录不存在时先创建，让首次启动即可用。
pub fn scan(cache_dir: &Path) -> Result<Vec<AgentInfo>, String> {
    let root = cache_dir.join(AGENTS_DIR);
    fs::create_dir_all(&root).map_err(|error| format!("创建 Agent 目录失败: {error}"))?;
    let agents = scan_root(&root);
    fs::write(cache_dir.join(INDEX_FILE), render_index(&agents))
        .map_err(|error| format!("写入 Agent 索引失败: {error}"))?;
    Ok(agents)
}

/// 校验 agent id（开发者 Jan），返回去空白后的合法 id。
///
/// id 会作为单层目录名参与路径拼接，因此必须挡住 `.` / `..`、路径分隔符与非 ASCII 字符，
/// 否则「agent id」就能被用来把目录写到 agent 根目录之外。
fn validate_agent_id(raw: &str) -> Result<String, String> {
    let id = raw.trim();
    if id.is_empty() || id == "." || id == ".." {
        return Err("Agent id 不能为空，也不能是 . 或 ..。".to_string());
    }
    if id.starts_with('/') || id.contains('/') || id.contains('\\') {
        return Err("Agent id 只能是单层目录名，不能包含路径分隔符。".to_string());
    }
    if !id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Agent id 只允许 ASCII 字母、数字、短横线和下划线。".to_string());
    }
    Ok(id.to_string())
}

/// 取 agent 根目录（开发者 Jan），不存在时创建。
fn agents_root(cache_dir: &Path) -> Result<PathBuf, String> {
    let root = cache_dir.join(AGENTS_DIR);
    fs::create_dir_all(&root).map_err(|error| format!("创建 Agent 目录失败: {error}"))?;
    Ok(root)
}

/// 把 agent 的字段拼成一份带 frontmatter 的 AGENT.md（开发者 Jan）。
///
/// 名称 / 说明 / 模型 / 权限档都先 trim：frontmatter 逐行解析，值里混进换行会把后面的内容
/// 顶到下一行，导致索引里读到残缺的值。`tools` 以逗号加空格连接，空列表输出为空值。
fn render_agent(
    name: &str,
    description: &str,
    model: &str,
    tools: &[String],
    permission_mode: &str,
    system_append: &str,
) -> String {
    let tools_value = tools
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "---\nname: {}\ndescription: {}\nmodel: {}\ntools: {}\npermissionMode: {}\n---\n\n{}",
        serde_json::to_string(name.trim()).expect("字符串序列化不会失败"),
        serde_json::to_string(description.trim()).expect("字符串序列化不会失败"),
        serde_json::to_string(model.trim()).expect("字符串序列化不会失败"),
        serde_json::to_string(&tools_value).expect("字符串序列化不会失败"),
        serde_json::to_string(permission_mode.trim()).expect("字符串序列化不会失败"),
        system_append
    )
}

/// 原子写入一个 agent 文件（开发者 Jan）：先写同目录下的临时文件，再 rename 覆盖目标。
///
/// 直接截断重写目标文件时，中途失败会留下半份内容；rename 在同一文件系统内是原子的，
/// 因此要么是旧内容、要么是新内容。失败时顺手清掉临时文件，避免 agent 目录里堆积残留。
fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Agent 文件路径无父目录。".to_string())?;
    let temp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name().unwrap().to_string_lossy(),
        std::process::id()
    ));
    fs::write(&temp, contents).map_err(|error| format!("写入临时 Agent 文件失败: {error}"))?;
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(format!("替换 Agent 文件失败: {error}"));
    }
    Ok(())
}

/// 删除一个 agent 目录及其全部内容（开发者 Jan）。
fn remove_dir(path: &Path) -> Result<(), String> {
    fs::remove_dir_all(path).map_err(|error| format!("删除 Agent 目录失败: {error}"))
}

/// 新建一个 agent（开发者 Jan），返回最新 agent 列表。
///
/// 已存在且未显式 overwrite 时拒绝，避免悄悄覆盖用户已调好的 agent；
/// 写入失败时把刚建出的目录删掉，不留半个空 agent。成功与否都会重扫一次目录。
pub fn create(cache_dir: &Path, input: CreateAgentInput) -> Result<Vec<AgentInfo>, String> {
    let id = validate_agent_id(&input.id)?;
    let root = agents_root(cache_dir)?;
    let dir = root.join(&id);
    if dir.exists() && !input.overwrite {
        return Err(format!("Agent 已存在：{id}。如需覆盖请明确确认。"));
    }
    if dir.exists() {
        remove_dir(&dir)?;
    }
    fs::create_dir_all(&dir).map_err(|error| format!("创建 Agent 目录失败: {error}"))?;
    if let Err(error) = write_atomic(
        &dir.join(AGENT_FILE),
        &render_agent(
            &input.name,
            &input.description,
            &input.model,
            &input.tools,
            &input.permission_mode,
            &input.system_append,
        ),
    ) {
        let _ = fs::remove_dir_all(&dir);
        return Err(error);
    }
    scan(cache_dir)
}

/// 更新一个 agent（开发者 Jan），支持同时改 id（改名目录）。
///
/// 分两种情况：id 不变时直接原子重写 AGENT.md；id 变化时先把新内容写进临时目录，
/// 再把旧目录改名为备份、把临时目录改名为正式目录，任何一步失败都回滚。
/// 走两步 rename 而不是「删旧再建新」，是因为改名过程本身可能失败，
/// 而用户改 id 时最怕的正是原 agent 被弄丢。
pub fn update(cache_dir: &Path, input: UpdateAgentInput) -> Result<Vec<AgentInfo>, String> {
    let original_id = validate_agent_id(&input.original_id)?;
    let id = validate_agent_id(&input.id)?;
    let root = agents_root(cache_dir)?;
    let original = root.join(&original_id);
    let target = root.join(&id);
    if !original.is_dir() || !original.join(AGENT_FILE).is_file() {
        return Err(format!("原 Agent 不存在：{original_id}"));
    }
    if original != target && target.exists() && !input.overwrite {
        return Err(format!("目标 Agent 已存在：{id}。如需覆盖请明确确认。"));
    }
    let contents = render_agent(
        &input.name,
        &input.description,
        &input.model,
        &input.tools,
        &input.permission_mode,
        &input.system_append,
    );
    if original == target {
        write_atomic(&target.join(AGENT_FILE), &contents)?;
    } else {
        let temp = root.join(format!(".agent-update-{}-{}", id, std::process::id()));
        if temp.exists() {
            let _ = fs::remove_dir_all(&temp);
        }
        fs::create_dir_all(&temp).map_err(|error| format!("创建临时 Agent 目录失败: {error}"))?;
        if let Err(error) = write_atomic(&temp.join(AGENT_FILE), &contents) {
            let _ = fs::remove_dir_all(&temp);
            return Err(error);
        }
        let backup = root.join(format!(".agent-backup-{}-{}", id, std::process::id()));
        if target.exists() {
            fs::rename(&target, &backup).map_err(|error| format!("备份目标 Agent 失败: {error}"))?;
        }
        if let Err(error) = fs::rename(&temp, &target) {
            if backup.exists() {
                let _ = fs::rename(&backup, &target);
            }
            let _ = fs::remove_dir_all(&temp);
            return Err(format!("替换目标 Agent 失败: {error}"));
        }
        let _ = fs::remove_dir_all(&backup);
        remove_dir(&original)?;
    }
    scan(cache_dir)
}

/// 删除一个 agent（开发者 Jan）：agent 不存在时报错，避免「以为删掉了其实没删」。
pub fn delete(cache_dir: &Path, input: DeleteAgentInput) -> Result<Vec<AgentInfo>, String> {
    let id = validate_agent_id(&input.id)?;
    let root = agents_root(cache_dir)?;
    let dir = root.join(&id);
    if !dir.is_dir() || !dir.join(AGENT_FILE).is_file() {
        return Err(format!("Agent 不存在：{id}"));
    }
    remove_dir(&dir)?;
    scan(cache_dir)
}

/// 扫描 agent 目录并刷新索引（开发者 Jan）；前端 Agent 页与启动流程都走这个命令。
#[tauri::command]
pub fn scan_agents(cache_dir: String) -> Result<Vec<AgentInfo>, String> {
    scan(Path::new(&cache_dir))
}

/// 新建 agent（开发者 Jan）：已存在且未授权覆盖时报错。
#[tauri::command]
pub fn create_agent(cache_dir: String, input: CreateAgentInput) -> Result<Vec<AgentInfo>, String> {
    create(Path::new(&cache_dir), input)
}

/// 更新 agent（开发者 Jan）：支持改 id（改名目录），失败时回滚保留原 agent。
#[tauri::command]
pub fn update_agent(cache_dir: String, input: UpdateAgentInput) -> Result<Vec<AgentInfo>, String> {
    update(Path::new(&cache_dir), input)
}

/// 删除 agent（开发者 Jan）：连带删除其目录并重建索引。
#[tauri::command]
pub fn delete_agent(cache_dir: String, input: DeleteAgentInput) -> Result<Vec<AgentInfo>, String> {
    delete(Path::new(&cache_dir), input)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("octopuses-agents-test-{}-{}", std::process::id(), name));
        if dir.exists() {
            fs::remove_dir_all(&dir).expect("清理测试目录失败");
        }
        dir
    }

    fn write_agent(cache: &Path, dir_name: &str, body: &str) {
        let dir = cache.join(AGENTS_DIR).join(dir_name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(AGENT_FILE), body).unwrap();
    }

    fn create_input(id: &str) -> CreateAgentInput {
        CreateAgentInput {
            id: id.to_string(),
            name: id.to_string(),
            description: "说明".to_string(),
            model: String::new(),
            tools: Vec::new(),
            permission_mode: String::new(),
            system_append: "persona".to_string(),
            overwrite: false,
        }
    }

    #[test]
    fn parses_frontmatter_fields_and_body() {
        let text = "---\nname: 代码审查员\ndescription: \"专注审查 diff\"\nmodel: claude-sonnet\ntools: workspace, ssh, read_file\npermissionMode: auto-readonly\n---\n\n你是严格的审查员。";
        let parsed = parse_frontmatter(text);
        assert_eq!(parsed.name.as_deref(), Some("代码审查员"));
        assert_eq!(parsed.description.as_deref(), Some("专注审查 diff"));
        assert_eq!(parsed.model.as_deref(), Some("claude-sonnet"));
        assert_eq!(
            parsed.tools.as_deref(),
            Some(["workspace", "ssh", "read_file"].map(String::from).as_slice())
        );
        assert_eq!(parsed.permission_mode.as_deref(), Some("auto-readonly"));
        assert_eq!(parsed.body, "你是严格的审查员。");
    }

    #[test]
    fn block_description_preserves_agent_body_and_tools() {
        let parsed = parse_frontmatter("---\nname: agent\ndescription: >-\n  first\n  second\ntools: *\n---\n\nPersona");
        assert_eq!(parsed.description.as_deref(), Some("first second"));
        assert_eq!(parsed.tools.unwrap(), vec!["*"]);
        assert_eq!(parsed.body, "Persona");
        let broken = parse_frontmatter("---\ndescription: >bad\n---\nPersona");
        assert!(broken.description.unwrap().contains("解析失败"));
        assert!(broken.body.contains("Persona"));
    }

    #[test]
    fn tolerates_missing_frontmatter_and_extra_lines() {
        let parsed = parse_frontmatter("# 没有 frontmatter\nname: 不该被读取\n");
        assert!(parsed.name.is_none());
        assert!(parsed.body.contains("不该被读取"));
        let parsed = parse_frontmatter("---\ndescription: '单引号说明'\ntools: *\n---\n正文");
        assert!(parsed.name.is_none());
        assert_eq!(parsed.description.as_deref(), Some("单引号说明"));
        assert_eq!(parsed.tools.as_deref(), Some(["*"].map(String::from).as_slice()));
        assert_eq!(parsed.body, "正文");
    }

    #[test]
    fn scan_reads_agent_dirs_and_ignores_others() {
        let cache = scratch("scan");
        write_agent(
            &cache,
            "beta",
            "---\nname: beta\ndescription: 第二个\n---\nbeta persona",
        );
        write_agent(&cache, "alpha", "alpha persona");
        fs::create_dir_all(cache.join(AGENTS_DIR).join("not-an-agent")).unwrap();
        fs::write(cache.join(AGENTS_DIR).join("README.md"), "忽略我").unwrap();
        let agents = scan(&cache).expect("扫描 Agent 失败");
        assert_eq!(agents.len(), 2);
        assert_eq!(agents[0].id, "alpha");
        assert_eq!(agents[1].name, "beta");
        assert_eq!(agents[0].system_append, "alpha persona");
        assert!(fs::read_to_string(cache.join(INDEX_FILE))
            .unwrap()
            .contains("共 2 个可用 Agent"));
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn scan_empty_dir_writes_placeholder_index() {
        let cache = scratch("empty");
        assert!(scan(&cache).unwrap().is_empty());
        assert!(fs::read_to_string(cache.join(INDEX_FILE))
            .unwrap()
            .contains("当前没有可用 Agent"));
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn validates_safe_agent_ids() {
        for id in ["", ".", "..", "/tmp", "a/b", "a\\b", "a..b", "技能"] {
            assert!(validate_agent_id(id).is_err(), "应拒绝 {id}");
        }
        assert_eq!(validate_agent_id("code-review_2").unwrap(), "code-review_2");
    }

    #[test]
    fn create_requires_explicit_overwrite_and_round_trips_fields() {
        let cache = scratch("create");
        let mut input = create_input("demo");
        input.model = "gpt-x".to_string();
        input.tools = vec!["workspace".to_string(), "read_file".to_string()];
        input.permission_mode = "auto-readonly".to_string();
        let agents = create(&cache, input).unwrap();
        assert_eq!(agents[0].model, "gpt-x");
        assert_eq!(agents[0].tools, vec!["workspace", "read_file"]);
        assert_eq!(agents[0].permission_mode, "auto-readonly");
        assert_eq!(agents[0].system_append, "persona");
        let error = create(&cache, create_input("demo")).unwrap_err();
        assert!(error.contains("覆盖"));
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn update_renames_and_keeps_old_on_failure() {
        let cache = scratch("update");
        create(&cache, create_input("old")).unwrap();
        let input = UpdateAgentInput {
            original_id: "old".into(),
            id: "new".into(),
            name: "new".into(),
            description: "".into(),
            model: "".into(),
            tools: vec![],
            permission_mode: "".into(),
            system_append: "body".into(),
            overwrite: false,
        };
        update(&cache, input.clone()).unwrap();
        assert!(!cache.join(AGENTS_DIR).join("old").exists());
        assert!(cache.join(AGENTS_DIR).join("new").exists());
        let mut missing = input;
        missing.original_id = "missing".into();
        assert!(update(&cache, missing).is_err());
        assert!(cache.join(AGENTS_DIR).join("new").join(AGENT_FILE).exists());
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn delete_rejects_missing_and_deletes_one_directory() {
        let cache = scratch("delete");
        create(&cache, create_input("demo")).unwrap();
        assert!(delete(
            &cache,
            DeleteAgentInput {
                id: "missing".into()
            }
        )
        .is_err());
        delete(
            &cache,
            DeleteAgentInput {
                id: "demo".into(),
            },
        )
        .unwrap();
        assert!(!cache.join(AGENTS_DIR).join("demo").exists());
        fs::remove_dir_all(&cache).ok();
    }
}
