//! 技能装载与 `use_skill` 工具。
//!
//! 技能以 `<技能根>/<目录名>/SKILL.md` 组织，文件由 YAML 前置区（首尾以 `---` 包裹）与正文组成：
//!
//! ```markdown
//! ---
//! name: fix-bug
//! description: 定位并修复缺陷，补充回归测试
//! allowed_tools: [read_file, shell, apply_patch]
//! ---
//! 正文……
//! ```
//!
//! 搜索顺序（后者覆盖前者）：用户级 `dirs::config_dir()/octopuses/skills/` →
//! 项目级 `<工作区>/.octopuses/skills/` → `skills.paths[]`。
//! 同名技能按「后写覆盖」处理，因此优先级最高的是 `skills.paths[]`。
//!
//! 正文只在模型调用 `use_skill` 时读入，且**不接受路径参数**（只接受技能名），
//! 因此不存在路径穿越的输入面，无需经过沙箱守卫。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use ots_config::OtsConfig;
use ots_core::{
    RiskLevel, SkillRegistry, SkillSource, SkillSpec, Tool, ToolContext, ToolError, ToolInvocation,
    ToolResult, ToolSpec, USE_SKILL_TOOL_NAME, truncate_output,
};
use serde::Deserialize;
use serde_json::Value;

/// 技能定义文件名。
pub const SKILL_FILE_NAME: &str = "SKILL.md";

/// 存放技能子目录的目录名（用户级与项目级共用）。
pub const SKILLS_DIR_NAME: &str = "skills";

/// `SKILL.md` 的 YAML 前置区。
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillFrontmatter {
    /// 技能名；缺省时取所在目录名。
    #[serde(default)]
    name: Option<String>,
    /// 一句话描述。
    #[serde(default)]
    description: Option<String>,
    /// 允许使用的工具；缺省表示不约束，`[]` 表示只允许 `use_skill`。
    #[serde(default)]
    allowed_tools: Option<Vec<String>>,
}

/// 依据配置与工作区装载技能注册表。
///
/// `skills.enabled = false` 时返回空注册表（既不扫描目录，也不会注册 `use_skill`）。
pub fn load_skills(config: &OtsConfig, workspace: &Path) -> SkillRegistry {
    let mut registry = SkillRegistry::new();
    if !config.skills.enabled {
        return registry;
    }

    let disabled: BTreeSet<&str> = config.skills.disabled.iter().map(String::as_str).collect();
    let mut roots: Vec<(PathBuf, SkillSource)> = Vec::new();
    if let Some(dir) = ots_config::user_config_dir() {
        roots.push((dir.join(SKILLS_DIR_NAME), SkillSource::User));
    }
    roots.push((workspace.join(".octopuses").join(SKILLS_DIR_NAME), SkillSource::Project));
    for path in &config.skills.paths {
        if path.as_os_str().is_empty() {
            continue;
        }
        let root = if path.is_absolute() { path.clone() } else { workspace.join(path) };
        roots.push((root, SkillSource::Config));
    }

    for (root, source) in roots {
        load_root(&root, source, &disabled, &mut registry);
    }
    if !registry.is_empty() {
        tracing::debug!("已装载 {} 个技能: {}", registry.len(), registry.names().join("、"));
    }
    registry
}

/// 扫描一个技能根目录。
fn load_root(root: &Path, source: SkillSource, disabled: &BTreeSet<&str>, registry: &mut SkillRegistry) {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
        Err(err) => {
            tracing::warn!("读取技能目录 {} 失败: {err}", root.display());
            return;
        }
    };

    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    // 排序保证装载顺序稳定，便于复现与测试。
    dirs.sort();

    for dir in dirs {
        let file = dir.join(SKILL_FILE_NAME);
        if !file.is_file() {
            continue;
        }
        let fallback = dir.file_name().and_then(|name| name.to_str()).unwrap_or_default();
        match read_skill(&file, fallback, source) {
            Ok(spec) => {
                if disabled.contains(spec.name.as_str()) {
                    tracing::debug!("技能 {} 在 skills.disabled 中，已跳过", spec.name);
                    continue;
                }
                registry.insert(spec);
            }
            Err(err) => tracing::warn!("跳过技能 {}: {err}", file.display()),
        }
    }
}

/// 读取并解析一个 `SKILL.md`。
fn read_skill(file: &Path, fallback_name: &str, source: SkillSource) -> Result<SkillSpec, String> {
    let text = std::fs::read_to_string(file).map_err(|err| format!("读取失败: {err}"))?;
    parse_skill(&text, fallback_name, file, source)
}

/// 把 `SKILL.md` 文本解析为技能元数据（不触碰文件系统，便于单测）。
///
/// 名称为空时回退到所在目录名；仍为空或含空白字符则视为非法。
fn parse_skill(text: &str, fallback_name: &str, file: &Path, source: SkillSource) -> Result<SkillSpec, String> {
    let (front, _) = split_frontmatter(text)?;
    let meta: SkillFrontmatter =
        serde_yaml::from_str(front).map_err(|err| format!("YAML 前置区解析失败: {err}"))?;

    let name = meta
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(fallback_name)
        .to_string();
    if name.is_empty() {
        return Err("技能名为空，且无法从目录名推导".to_string());
    }
    if name.chars().any(char::is_whitespace) {
        return Err(format!("技能名 `{name}` 不能包含空白字符"));
    }

    let description = meta.description.as_deref().map(str::trim).unwrap_or_default().to_string();
    let allowed_tools = meta.allowed_tools.map(|tools| {
        tools.into_iter().map(|tool| tool.trim().to_string()).filter(|tool| !tool.is_empty()).collect::<BTreeSet<String>>()
    });

    Ok(SkillSpec::new(name, description, file.to_path_buf(), source).with_allowed_tools(allowed_tools))
}

/// 读取技能正文：剥离 YAML 前置区，按 `max_body_bytes` 截断，返回 `(正文, 是否截断)`。
///
/// 供 `use_skill` 工具与 `ots skills show` 共用，避免两处重复实现读取与截断逻辑。
pub fn read_skill_body(spec: &SkillSpec, max_body_bytes: usize) -> Result<(String, bool), String> {
    let text = std::fs::read_to_string(&spec.path)
        .map_err(|err| format!("读取技能文件 {} 失败: {err}", spec.path.display()))?;
    let body = match split_frontmatter(&text) {
        Ok((_, body)) => body,
        Err(_) => text.as_str(),
    };
    Ok(truncate_output(body.trim(), max_body_bytes))
}

/// 拆分 YAML 前置区与正文，返回 `(前置区, 正文)`。
fn split_frontmatter(text: &str) -> Result<(&str, &str), String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let rest = text.strip_prefix("---").ok_or("缺少 YAML 前置区（文件必须以 `---` 开头）")?;
    let rest = rest
        .strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))
        .ok_or("前置区的起始 `---` 之后必须换行")?;

    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        let marker = line.trim_end_matches(['\r', '\n']).trim_end();
        if marker == "---" || marker == "..." {
            return Ok((&rest[..offset], &rest[offset + line.len()..]));
        }
        offset += line.len();
    }
    Err("YAML 前置区没有结束分隔符 `---`".to_string())
}

/// `use_skill`：把技能正文按需读入上下文。
pub struct UseSkillTool {
    skills: Arc<SkillRegistry>,
    max_body_bytes: usize,
}

impl UseSkillTool {
    /// 内置工具名。
    pub const NAME: &'static str = USE_SKILL_TOOL_NAME;

    /// 构造工具。
    pub fn new(skills: Arc<SkillRegistry>, max_body_bytes: usize) -> Self {
        Self { skills, max_body_bytes }
    }

    /// 读取技能正文（剥离前置区并按上限截断）。
    fn body(&self, spec: &SkillSpec) -> Result<(String, bool), ToolError> {
        read_skill_body(spec, self.max_body_bytes).map_err(ToolError::Failed)
    }
}

#[async_trait]
impl Tool for UseSkillTool {
    /// 工具声明（开发者 Jan）：说明里要求模型先读技能再按步骤执行，避免跳过说明直接猜做法
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            Self::NAME,
            "载入一个技能的完整说明。当任务与某个技能匹配时，先调用它读取步骤，再按步骤执行。",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "技能名（见系统提示的「可用技能」列表）" }
                },
                "required": ["name"],
                "additionalProperties": false
            }),
            RiskLevel::Low,
            false,
        )
    }

    /// 按名读取技能正文（开发者 Jan）：未提供 name 时回退到技能索引，让模型先看看有哪些可用技能
    async fn invoke(&self, invocation: ToolInvocation, _ctx: &ToolContext) -> Result<ToolResult, ToolError> {
        let name = invocation
            .arguments
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| ToolError::Invalid("缺少 `name` 参数".to_string()))?;
        let spec = self.skills.get(name).ok_or_else(|| {
            ToolError::Invalid(format!("技能 `{name}` 不存在。可用技能: {}", self.skills.names().join("、")))
        })?;

        let (body, truncated) = self.body(spec)?;
        let mut stdout = format!("# 技能 `{}`\n", spec.name);
        if !spec.description.is_empty() {
            stdout.push_str(&format!("{}\n", spec.description));
        }
        if let Some(tools) = &spec.allowed_tools {
            stdout.push_str(&format!(
                "本技能生效期间可用工具: {}（其余调用会被拒绝）\n",
                render_tools(tools).join("、")
            ));
        }
        stdout.push_str("\n---\n\n");
        stdout.push_str(&body);
        if truncated {
            stdout.push_str(&format!("\n\n（正文超过 {} 字节，已截断）", self.max_body_bytes));
        }

        Ok(ToolResult::success(stdout).with_data(serde_json::json!({
            "skill": spec.name,
            "description": spec.description,
            "allowed_tools": spec.allowed_tools.as_ref().map(render_tools),
            "path": spec.path.display().to_string(),
            "truncated": truncated,
        })))
    }
}

/// 渲染允许的工具清单（附上始终可用的 `use_skill`）。
fn render_tools(tools: &BTreeSet<String>) -> Vec<String> {
    let mut list: Vec<String> = tools.iter().cloned().collect();
    if !list.iter().any(|tool| tool == USE_SKILL_TOOL_NAME) {
        list.push(USE_SKILL_TOOL_NAME.to_string());
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;
    use ots_core::ToolRuntime;
    use tokio_util::sync::CancellationToken;

    const SAMPLE: &str = "\
---
name: fix-bug
description: 定位并修复缺陷
allowed_tools: [read_file, shell]
---
第一步：读日志。
第二步：改代码。
";

    fn parse(text: &str, fallback: &str) -> Result<SkillSpec, String> {
        parse_skill(text, fallback, Path::new("/tmp/x/SKILL.md"), SkillSource::Project)
    }

    #[test]
    fn 解析前置区与正文() {
        let spec = parse(SAMPLE, "dir-name").expect("解析成功");
        assert_eq!(spec.name, "fix-bug");
        assert_eq!(spec.description, "定位并修复缺陷");
        let (_, body) = split_frontmatter(SAMPLE).expect("拆分成功");
        assert!(body.contains("第一步：读日志。"));
        assert!(!body.contains("description"));
    }

    #[test]
    fn 缺少前置区时报错() {
        assert!(parse("# 没有前置区\n正文", "x").is_err());
        assert!(parse("---\nname: a\n正文没闭合", "x").is_err());
    }

    #[test]
    fn 前置区拼写错误会被拒绝() {
        let text = "---\ndescription: 描述\nallowed_tool: [read_file]\n---\n正文";
        let err = parse(text, "fallback").expect_err("应报错");
        assert!(err.contains("YAML"), "{err}");
    }

    #[test]
    fn 名称缺省时回退到目录名() {
        let text = "---\ndescription: 描述\n---\n正文";
        assert_eq!(parse(text, "dir-name").expect("解析成功").name, "dir-name");
    }

    #[test]
    fn 未声明工具表示不约束_空数组表示只允许载入工具() {
        let text = "---\nname: a\n---\n正文";
        assert_eq!(parse(text, "a").expect("解析成功").allowed_tools, None);
        let text = "---\nname: a\nallowed_tools: []\n---\n正文";
        assert_eq!(parse(text, "a").expect("解析成功").allowed_tools, Some(BTreeSet::new()));
    }

    fn write_skill(root: &Path, dir: &str, name: &str, description: &str, allowed: &str) {
        let dir = root.join(dir);
        std::fs::create_dir_all(&dir).expect("建目录");
        std::fs::write(
            dir.join(SKILL_FILE_NAME),
            format!("---\nname: {name}\ndescription: {description}\n{allowed}---\n{description}的正文\n"),
        )
        .expect("写文件");
    }

    fn config_with_paths(workspace: &Path) -> OtsConfig {
        let mut config = OtsConfig::default();
        config.skills.paths = vec![workspace.join("extra")];
        config
    }

    #[test]
    fn 按顺序装载且同名覆盖() {
        let dir = tempfile::tempdir().expect("临时目录");
        let workspace = dir.path();
        write_skill(&workspace.join(".octopuses").join(SKILLS_DIR_NAME), "alpha", "alpha", "项目级", "");
        write_skill(&workspace.join("extra"), "alpha", "alpha", "配置声明", "allowed_tools: [read_file]\n");
        write_skill(&workspace.join("extra"), "beta", "beta", "配置声明", "");

        let registry = load_skills(&config_with_paths(workspace), workspace);
        assert_eq!(registry.names(), vec!["alpha".to_string(), "beta".to_string()]);
        let alpha = registry.get("alpha").expect("存在");
        assert_eq!(alpha.description, "配置声明", "skills.paths 优先级最高");
        assert_eq!(alpha.source, SkillSource::Config);
    }

    #[test]
    fn 黑名单与未启用时都不装载() {
        let dir = tempfile::tempdir().expect("临时目录");
        let workspace = dir.path();
        write_skill(&workspace.join("extra"), "alpha", "alpha", "描述", "");

        let mut config = config_with_paths(workspace);
        config.skills.disabled = vec!["alpha".to_string()];
        assert!(load_skills(&config, workspace).is_empty());

        let mut config = config_with_paths(workspace);
        config.skills.enabled = false;
        assert!(load_skills(&config, workspace).is_empty());
    }

    #[test]
    fn 没有技能文件时目录被忽略() {
        let dir = tempfile::tempdir().expect("临时目录");
        let workspace = dir.path();
        std::fs::create_dir_all(workspace.join("extra").join("empty")).expect("建目录");
        assert!(load_skills(&config_with_paths(workspace), workspace).is_empty());
    }

    fn tool(skills: SkillRegistry, max_body_bytes: usize) -> UseSkillTool {
        UseSkillTool::new(Arc::new(skills), max_body_bytes)
    }

    #[tokio::test]
    async fn 载入技能返回正文与结构化数据() {
        let dir = tempfile::tempdir().expect("临时目录");
        let workspace = dir.path();
        write_skill(&workspace.join("extra"), "alpha", "alpha", "描述", "allowed_tools: [read_file]\n");
        let skills = load_skills(&config_with_paths(workspace), workspace);

        let mut registry = ots_core::ToolRegistry::new();
        registry.register(tool(skills, 32 * 1024)).expect("注册成功");
        let runtime = ToolRuntime::new(registry, ots_core::ToolLimits::default());
        let ctx = ToolContext::permissive(workspace, CancellationToken::new());
        let result = runtime
            .execute(ToolInvocation::new("1", USE_SKILL_TOOL_NAME, serde_json::json!({ "name": "alpha" })), &ctx)
            .await;

        assert!(result.ok, "stderr={}", result.stderr);
        assert!(result.stdout.contains("描述的正文"));
        assert!(!result.stdout.contains("description: "), "正文不应包含前置区");
        let data = result.data.expect("有结构化数据");
        assert_eq!(data["skill"], "alpha");
        assert_eq!(data["allowed_tools"], serde_json::json!(["read_file", USE_SKILL_TOOL_NAME]));
    }

    #[tokio::test]
    async fn 未声明的技能不被约束() {
        let dir = tempfile::tempdir().expect("临时目录");
        let workspace = dir.path();
        write_skill(&workspace.join("extra"), "alpha", "alpha", "描述", "");
        let skills = load_skills(&config_with_paths(workspace), workspace);

        let mut registry = ots_core::ToolRegistry::new();
        registry.register(tool(skills, 32 * 1024)).expect("注册成功");
        let runtime = ToolRuntime::new(registry, ots_core::ToolLimits::default());
        let ctx = ToolContext::permissive(workspace, CancellationToken::new());
        let result = runtime
            .execute(ToolInvocation::new("1", USE_SKILL_TOOL_NAME, serde_json::json!({ "name": "alpha" })), &ctx)
            .await;

        assert!(result.ok);
        assert_eq!(result.data.expect("有结构化数据")["allowed_tools"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn 不存在的技能返回可读错误() {
        let dir = tempfile::tempdir().expect("临时目录");
        let workspace = dir.path();
        write_skill(&workspace.join("extra"), "alpha", "alpha", "描述", "");
        let skills = load_skills(&config_with_paths(workspace), workspace);

        let mut registry = ots_core::ToolRegistry::new();
        registry.register(tool(skills, 32 * 1024)).expect("注册成功");
        let runtime = ToolRuntime::new(registry, ots_core::ToolLimits::default());
        let ctx = ToolContext::permissive(workspace, CancellationToken::new());
        let result = runtime
            .execute(ToolInvocation::new("1", USE_SKILL_TOOL_NAME, serde_json::json!({ "name": "nope" })), &ctx)
            .await;

        assert!(!result.ok);
        assert!(result.stderr.contains("alpha"), "错误里应列出可用技能: {}", result.stderr);
    }

    #[tokio::test]
    async fn 超长正文被截断() {
        let dir = tempfile::tempdir().expect("临时目录");
        let workspace = dir.path();
        let skill_dir = workspace.join("extra").join("big");
        std::fs::create_dir_all(&skill_dir).expect("建目录");
        let body = "字".repeat(2000);
        std::fs::write(skill_dir.join(SKILL_FILE_NAME), format!("---\nname: big\n---\n{body}")).expect("写文件");
        let skills = load_skills(&config_with_paths(workspace), workspace);

        let mut registry = ots_core::ToolRegistry::new();
        registry.register(tool(skills, 1024)).expect("注册成功");
        let runtime = ToolRuntime::new(registry, ots_core::ToolLimits::default());
        let ctx = ToolContext::permissive(workspace, CancellationToken::new());
        let result = runtime
            .execute(ToolInvocation::new("1", USE_SKILL_TOOL_NAME, serde_json::json!({ "name": "big" })), &ctx)
            .await;

        assert!(result.ok);
        assert!(result.stdout.contains("已截断"));
        assert_eq!(result.data.expect("有结构化数据")["truncated"], true);
    }
}