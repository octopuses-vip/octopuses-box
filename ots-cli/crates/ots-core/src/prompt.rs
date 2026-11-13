//! 系统提示词构建。
//!
//! 提示词由「固定角色约定」+「运行时环境事实」+「项目指令」三部分拼装，
//! 环境事实全部来自配置而非硬编码，便于审计与复现。

use crate::policy::PermissionMode;
use crate::skill::{SkillIndexEntry, USE_SKILL_TOOL_NAME};

/// 构建系统提示词所需的运行时信息。
#[derive(Debug, Clone)]
pub struct AgentInstructions {
    /// 工作区根目录（展示用）。
    pub workspace: String,
    /// 当前权限模式。
    pub mode: PermissionMode,
    /// 可用工具名。
    pub tools: Vec<String>,
    /// 可用技能索引（只有名称与描述，正文按需加载）。
    pub skills: Vec<SkillIndexEntry>,
    /// 项目指令（例如 `AGENTS.md` 内容）。
    pub project_instructions: Option<String>,
    /// 用户追加的系统提示。
    pub extra_system_prompt: Option<String>,
    /// 沙箱描述。
    pub sandbox: String,
    /// 验证方式描述（例如将要执行的测试命令）。
    pub verification: Option<String>,
}

impl Default for AgentInstructions {
    /// 注入模型的指令默认值（开发者 Jan）：工作区取当前目录、权限 Auto、逻辑沙箱。
    ///
    /// 默认不带项目指令与验证描述，由调用方按实际情况补齐。
    fn default() -> Self {
        Self {
            workspace: ".".to_string(),
            mode: PermissionMode::Auto,
            tools: Vec::new(),
            skills: Vec::new(),
            project_instructions: None,
            extra_system_prompt: None,
            sandbox: "逻辑沙箱".to_string(),
            verification: None,
        }
    }
}

const ROLE_CONTRACT: &str = "\
你是 ots-cli，一个在本地终端中工作的软件工程智能体。
你通过调用工具来读取代码、执行命令、修改文件，并持续迭代直到目标达成。

工作方式：
1. 先理解目标与现有代码，再动手修改；不要臆测未读过的文件内容。
2. 修改代码必须通过工具进行，不要只在回复里贴出代码而不落盘。
3. 每次只做必要的改动，遵循仓库既有的风格与约定。
4. 完成任务后如实说明你做了什么、验证了什么；不要声称执行过实际未执行的操作。
5. 如果工具返回失败，请阅读错误信息并修正后重试，不要重复提交同样的参数。

约束：
- 所有相对路径都相对于工作区根目录。
- 破坏性操作（删除文件、重置仓库、访问工作区之外的路径）会进入人工审批。
- 不要尝试绕过审批或沙箱限制；如果被拒绝，请换一种可行的方案并说明原因。
";

/// 构建系统提示词。
pub fn build_system_prompt(instructions: &AgentInstructions) -> String {
    let mut out = String::with_capacity(2048);
    out.push_str(ROLE_CONTRACT);

    out.push_str("\n# 运行环境\n");
    out.push_str(&format!("- 操作系统: {}\n", std::env::consts::OS));
    out.push_str(&format!("- 工作区根目录: {}\n", instructions.workspace));
    out.push_str(&format!("- 权限模式: {}\n", instructions.mode.as_str()));
    out.push_str(&format!("- 沙箱: {}\n", instructions.sandbox));

    if !instructions.tools.is_empty() {
        out.push_str("\n# 可用工具\n");
        out.push_str(&instructions.tools.join("、"));
        out.push('\n');
    }

    if !instructions.skills.is_empty() {
        out.push_str("\n# 可用技能\n");
        out.push_str(&format!(
            "以下技能封装了专门的工作流。当任务与某个技能匹配时，先调用 `{USE_SKILL_TOOL_NAME}` \
             载入它声明的完整说明，再严格按说明执行；不要臆造未列出的技能。\n"
        ));
        for skill in &instructions.skills {
            let description = skill.description.trim();
            if description.is_empty() {
                out.push_str(&format!("- {}\n", skill.name));
            } else {
                out.push_str(&format!("- {}: {description}\n", skill.name));
            }
        }
    }

    if let Some(verification) = &instructions.verification {
        out.push_str("\n# 验证方式\n");
        out.push_str(verification);
        out.push('\n');
        out.push_str("请在完成改动后确保验证可以通过。\n");
    }

    if let Some(project) = instructions.project_instructions.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        out.push_str("\n# 项目指令\n");
        out.push_str(project);
        out.push('\n');
    }

    if let Some(extra) = instructions.extra_system_prompt.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        out.push_str("\n# 附加要求\n");
        out.push_str(extra);
        out.push('\n');
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 提示词包含环境与项目指令() {
        let instructions = AgentInstructions {
            workspace: "/tmp/demo".to_string(),
            tools: vec!["shell".into(), "read_file".into()],
            project_instructions: Some("始终运行 cargo fmt".to_string()),
            ..Default::default()
        };
        let prompt = build_system_prompt(&instructions);
        assert!(prompt.contains("/tmp/demo"));
        assert!(prompt.contains("shell、read_file"));
        assert!(prompt.contains("始终运行 cargo fmt"));
    }

    #[test]
    fn 提示词只放技能索引不放正文() {
        let instructions = AgentInstructions {
            skills: vec![
                SkillIndexEntry { name: "fix-bug".to_string(), description: "定位并修复缺陷".to_string() },
                SkillIndexEntry { name: "noop".to_string(), description: String::new() },
            ],
            ..Default::default()
        };
        let prompt = build_system_prompt(&instructions);
        assert!(prompt.contains("# 可用技能"));
        assert!(prompt.contains("use_skill"));
        assert!(prompt.contains("- fix-bug: 定位并修复缺陷"));
        assert!(prompt.contains("- noop\n"));
    }

    #[test]
    fn 没有技能时不输出技能段() {
        let prompt = build_system_prompt(&AgentInstructions::default());
        assert!(!prompt.contains("# 可用技能"));
    }
}
