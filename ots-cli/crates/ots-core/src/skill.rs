//! 技能（Skill）：以 Markdown 正文 + YAML 前置区声明的可复用工作流。
//!
//! 本模块只承载**元数据**（名称、描述、允许的工具、文件路径与来源），不读取正文：
//! 正文由外层 crate 在模型真正调用 [`USE_SKILL_TOOL_NAME`] 时按需读入。
//! 这样系统提示里只放「名称 + 描述」索引，提示词开销与单个技能的正文长度解耦。

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 载入技能正文的内置工具名。
///
/// 模型通过调用它把技能正文读进上下文。工具收窄时会**无条件保留**该工具，
/// 避免模型被锁死在已加载的那一个技能里而无法再加载其它技能。
pub const USE_SKILL_TOOL_NAME: &str = "use_skill";

/// 技能来源层级（按搜索顺序排列，越靠后优先级越高）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillSource {
    /// 用户级技能目录。
    User,
    /// 项目级技能目录。
    Project,
    /// `skills.paths[]` 中显式声明的技能目录。
    Config,
}

impl SkillSource {
    /// 中文名。
    pub fn label(&self) -> &'static str {
        match self {
            Self::User => "用户级",
            Self::Project => "项目级",
            Self::Config => "配置声明",
        }
    }
}

/// 技能元数据。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillSpec {
    /// 技能名（唯一，模型通过 `use_skill` 引用）。
    pub name: String,
    /// 面向模型的一句话描述，用于系统提示里的索引。
    pub description: String,
    /// 允许使用的工具范围；`None` 表示不约束工具。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<BTreeSet<String>>,
    /// 技能正文文件（`SKILL.md`）路径。
    pub path: PathBuf,
    /// 来源层级。
    pub source: SkillSource,
}

impl SkillSpec {
    /// 构造技能元数据（默认不约束工具）。
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        path: PathBuf,
        source: SkillSource,
    ) -> Self {
        Self { name: name.into(), description: description.into(), allowed_tools: None, path, source }
    }

    /// 指定允许使用的工具范围。
    #[must_use]
    pub fn with_allowed_tools(mut self, allowed_tools: Option<BTreeSet<String>>) -> Self {
        self.allowed_tools = allowed_tools;
        self
    }

    /// 允许的工具名（排序后），用于展示；不约束时返回空列表。
    pub fn allowed_tools_sorted(&self) -> Vec<String> {
        self.allowed_tools.as_ref().map(|tools| tools.iter().cloned().collect()).unwrap_or_default()
    }

    /// 转为系统提示中的索引条目。
    pub fn index_entry(&self) -> SkillIndexEntry {
        SkillIndexEntry { name: self.name.clone(), description: self.description.clone() }
    }
}

/// 系统提示中的技能索引条目：只有名称与描述，正文按需加载。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillIndexEntry {
    /// 技能名。
    pub name: String,
    /// 一句话描述。
    pub description: String,
}

/// 技能注册表：名称 → 元数据。
///
/// 只做内存映射，不触碰文件系统；同名插入按「后写覆盖」处理，
/// 因此调用方只需按搜索顺序（低优先级在前）依次插入即可实现覆盖语义。
#[derive(Debug, Clone, Default)]
pub struct SkillRegistry {
    skills: BTreeMap<String, SkillSpec>,
}

impl SkillRegistry {
    /// 空注册表。
    pub fn new() -> Self {
        Self::default()
    }

    /// 插入（或覆盖）一个技能。
    pub fn insert(&mut self, spec: SkillSpec) {
        self.skills.insert(spec.name.clone(), spec);
    }

    /// 查询技能。
    pub fn get(&self, name: &str) -> Option<&SkillSpec> {
        self.skills.get(name)
    }

    /// 是否存在该技能。
    pub fn contains(&self, name: &str) -> bool {
        self.skills.contains_key(name)
    }

    /// 全部技能元数据（按名称排序）。
    pub fn specs(&self) -> Vec<&SkillSpec> {
        self.skills.values().collect()
    }

    /// 全部技能名（按名称排序）。
    pub fn names(&self) -> Vec<String> {
        self.skills.keys().cloned().collect()
    }

    /// 系统提示中使用的索引条目（按名称排序）。
    pub fn index(&self) -> Vec<SkillIndexEntry> {
        self.skills.values().map(SkillSpec::index_entry).collect()
    }

    /// 技能数量。
    pub fn len(&self) -> usize {
        self.skills.len()
    }

    /// 是否为空。
    pub fn is_empty(&self) -> bool {
        self.skills.is_empty()
    }
}

/// 把一次技能加载声明的工具范围并入当前会话范围（交集语义）。
///
/// - `declared = None`：该技能不约束工具，当前范围原样返回；
/// - `declared = Some(...)`：取「当前范围 ∩ declared」，并把 [`USE_SKILL_TOOL_NAME`]
///   无条件放回结果，保证模型仍能继续加载其它技能。
pub fn narrow_scope(current: Option<&BTreeSet<String>>, declared: Option<&[String]>) -> Option<BTreeSet<String>> {
    let Some(declared) = declared else {
        return current.cloned();
    };
    let allowed: BTreeSet<String> = declared.iter().cloned().collect();
    let mut narrowed: BTreeSet<String> = match current {
        Some(current) => current.intersection(&allowed).cloned().collect(),
        None => allowed,
    };
    // 交集可能把载入工具本身排除掉，那样模型就再也无法加载其它技能，因此无条件放回。
    narrowed.insert(USE_SKILL_TOOL_NAME.to_string());
    Some(narrowed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn spec(name: &str, allowed: Option<&[&str]>) -> SkillSpec {
        SkillSpec::new(name, format!("{name} 的描述"), Path::new("/tmp").join(name).join("SKILL.md"), SkillSource::User)
            .with_allowed_tools(allowed.map(|tools| tools.iter().map(|tool| (*tool).to_string()).collect()))
    }

    #[test]
    fn 同名技能后写覆盖() {
        let mut registry = SkillRegistry::new();
        registry.insert(spec("a", None));
        registry.insert(SkillSpec::new("a", "覆盖后的描述", Path::new("/tmp/a2/SKILL.md").to_path_buf(), SkillSource::Project));
        assert_eq!(registry.len(), 1);
        assert_eq!(registry.get("a").expect("存在").description, "覆盖后的描述");
    }

    #[test]
    fn 索引只包含名称与描述() {
        let mut registry = SkillRegistry::new();
        registry.insert(spec("zeta", Some(&["read_file"])));
        registry.insert(spec("alpha", None));
        let index = registry.index();
        assert_eq!(index.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(), vec!["alpha", "zeta"]);
        assert_eq!(index[0].description, "alpha 的描述");
    }

    #[test]
    fn 不约束的技能不改变当前范围() {
        let current: BTreeSet<String> = ["read_file".to_string()].into_iter().collect();
        assert_eq!(narrow_scope(Some(&current), None), Some(current.clone()));
        assert_eq!(narrow_scope(None, None), None);
    }

    #[test]
    fn 收窄取交集并保留载入工具() {
        let current: BTreeSet<String> = ["read_file".to_string(), "shell".to_string()].into_iter().collect();
        let narrowed = narrow_scope(Some(&current), Some(&["shell".to_string()])).expect("已收窄");
        assert_eq!(narrowed, ["shell".to_string(), USE_SKILL_TOOL_NAME.to_string()].into_iter().collect());
    }

    #[test]
    fn 收窄结果始终保留载入工具() {
        let narrowed = narrow_scope(None, Some(&[])).expect("已收窄");
        assert_eq!(narrowed, [USE_SKILL_TOOL_NAME.to_string()].into_iter().collect());
    }
}