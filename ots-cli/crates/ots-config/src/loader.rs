//! 分层配置加载：默认 → 用户级 → 项目级 → 显式文件 → 环境变量 → 命令行参数。
//!
//! 合并策略为「深度合并」：对象逐层递归合并，数组与标量整体覆盖。
//! 环境变量采用 `OTS__<路径>` 形式，`__` 表示层级，例如
//! `OTS__LLM__MODEL=gpt-4o`、`OTS__AGENT__MAX_ITERATIONS=12`。
//! 值的类型由默认配置中同路径既有类型推导，避免把数字写成字符串。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::error::{ConfigError, ConfigResult};
use crate::schema::OtsConfig;

/// 配置来源类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigSourceKind {
    /// 内置默认值。
    Defaults,
    /// 用户级配置。
    User,
    /// 项目级配置。
    Project,
    /// `--config` 显式指定。
    Explicit,
    /// 环境变量。
    Environment,
    /// 命令行参数。
    CommandLine,
}

impl ConfigSourceKind {
    /// 中文名。
    pub fn label(&self) -> &'static str {
        match self {
            Self::Defaults => "内置默认",
            Self::User => "用户级",
            Self::Project => "项目级",
            Self::Explicit => "显式指定",
            Self::Environment => "环境变量",
            Self::CommandLine => "命令行",
        }
    }
}

/// 一条配置来源记录。
#[derive(Debug, Clone)]
pub struct ConfigSource {
    /// 来源类型。
    pub kind: ConfigSourceKind,
    /// 文件路径（环境变量与命令行无路径）。
    pub path: Option<PathBuf>,
    /// 文件是否存在。
    pub present: bool,
    /// 备注。
    pub note: Option<String>,
}

/// 加载选项。
#[derive(Debug, Clone)]
pub struct LoadOptions {
    /// 工作区根目录。
    pub workspace: PathBuf,
    /// 显式指定的配置文件（`--config` 或 `OTS_CONFIG`）。
    pub explicit: Option<PathBuf>,
    /// 命令行覆盖补丁（形如 `{"llm": {"model": "..."}}`）。
    pub cli_overrides: Option<Value>,
    /// 环境变量快照；为空时读取进程环境。
    pub env: Option<BTreeMap<String, String>>,
}

impl LoadOptions {
    /// 以工作区构造默认加载选项。
    pub fn new(workspace: impl Into<PathBuf>) -> Self {
        Self { workspace: workspace.into(), explicit: None, cli_overrides: None, env: None }
    }

    /// 指定显式配置文件。
    #[must_use]
    pub fn with_explicit(mut self, path: impl Into<PathBuf>) -> Self {
        self.explicit = Some(path.into());
        self
    }

    /// 指定命令行覆盖补丁。
    #[must_use]
    pub fn with_cli_overrides(mut self, patch: Value) -> Self {
        self.cli_overrides = Some(patch);
        self
    }

    /// 注入环境变量快照（测试用）。
    #[must_use]
    pub fn with_env(mut self, env: BTreeMap<String, String>) -> Self {
        self.env = Some(env);
        self
    }
}

/// 加载结果。
#[derive(Debug, Clone)]
pub struct LoadedConfig {
    /// 合并后的最终配置。
    pub config: OtsConfig,
    /// 生效的来源链路。
    pub sources: Vec<ConfigSource>,
    /// 实际生效的环境变量覆盖。
    pub env_applied: Vec<(String, String)>,
}

impl LoadedConfig {
    /// 最终配置的 JSON 表示，用于 `ots config show --json`。
    ///
    /// # Errors
    /// 序列化失败时返回错误。
    pub fn to_json(&self) -> ConfigResult<Value> {
        Ok(serde_json::to_value(&self.config)?)
    }
}

/// 用户级配置目录（`dirs::config_dir()` 下的 `octopuses`）。
///
/// macOS 为 `~/Library/Application Support/octopuses`，Linux 为 `~/.config/octopuses`。
/// 实际生效路径以 `ots config path` 的输出为准。
pub fn user_config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("octopuses"))
}

/// 用户级配置文件路径。
pub fn user_config_path() -> Option<PathBuf> {
    user_config_dir().map(|dir| dir.join("config.toml"))
}

/// 项目级配置文件路径。
pub fn project_config_path(workspace: &Path) -> PathBuf {
    workspace.join(".octopuses").join("config.toml")
}

/// 执行分层加载。
///
/// # Errors
/// 配置文件读取/解析失败、环境变量无法应用或最终配置非法时返回错误。
pub fn load(options: &LoadOptions) -> ConfigResult<LoadedConfig> {
    let env = match &options.env {
        Some(env) => env.clone(),
        None => std::env::vars().collect(),
    };

    let mut doc = serde_json::to_value(OtsConfig::default())?;
    let mut sources = vec![ConfigSource { kind: ConfigSourceKind::Defaults, path: None, present: true, note: None }];

    let explicit = options.explicit.clone().or_else(|| env.get("OTS_CONFIG").map(PathBuf::from));

    if explicit.is_none() {
        if let Some(path) = user_config_path() {
            let present = path.is_file();
            if present {
                merge_file(&mut doc, &path)?;
            }
            sources.push(ConfigSource { kind: ConfigSourceKind::User, path: Some(path), present, note: None });
        }
    }

    let project_path = project_config_path(&options.workspace);
    let project_present = project_path.is_file();
    if project_present {
        merge_file(&mut doc, &project_path)?;
    }
    sources.push(ConfigSource { kind: ConfigSourceKind::Project, path: Some(project_path), present: project_present, note: None });

    if let Some(path) = &explicit {
        let present = path.is_file();
        if present {
            merge_file(&mut doc, path)?;
        }
        sources.push(ConfigSource {
            kind: ConfigSourceKind::Explicit,
            path: Some(path.clone()),
            present,
            note: if present { None } else { Some("文件不存在".to_string()) },
        });
    }

    let env_applied = apply_env(&mut doc, &env)?;
    if !env_applied.is_empty() {
        sources.push(ConfigSource {
            kind: ConfigSourceKind::Environment,
            path: None,
            present: true,
            note: Some(format!("{} 项覆盖", env_applied.len())),
        });
    }

    if let Some(patch) = &options.cli_overrides {
        if patch.as_object().is_some_and(|map| !map.is_empty()) {
            deep_merge(&mut doc, patch.clone());
            sources.push(ConfigSource { kind: ConfigSourceKind::CommandLine, path: None, present: true, note: None });
        }
    }

    let config: OtsConfig = serde_json::from_value(doc).map_err(|err| ConfigError::Parse {
        path: explicit.unwrap_or_else(|| PathBuf::from("<合并结果>")),
        reason: err.to_string(),
    })?;

    Ok(LoadedConfig { config, sources, env_applied })
}

/// 把一份 TOML 配置合并进已有配置树（开发者 Jan）。
///
/// 采用「深合并」而不是整体替换：多层配置（默认 → 用户级 → 项目级）叠加时，
/// 上层只需写要覆盖的那几项，未提及的字段继续沿用下层取值。
fn merge_file(doc: &mut Value, path: &Path) -> ConfigResult<()> {
    let text = std::fs::read_to_string(path).map_err(|source| ConfigError::Io { path: path.to_path_buf(), source })?;
    let parsed: toml::Value = toml::from_str(&text).map_err(|err| ConfigError::Parse {
        path: path.to_path_buf(),
        reason: err.to_string(),
    })?;
    let value = serde_json::to_value(parsed).map_err(|err| ConfigError::Parse {
        path: path.to_path_buf(),
        reason: err.to_string(),
    })?;
    deep_merge(doc, value);
    Ok(())
}

/// 深度合并：`overlay` 覆盖 `base`，对象递归、其它整体替换。
pub fn deep_merge(base: &mut Value, overlay: Value) {
    match (base, overlay) {
        (Value::Object(base_map), Value::Object(overlay_map)) => {
            for (key, value) in overlay_map {
                match base_map.get_mut(&key) {
                    Some(slot) => deep_merge(slot, value),
                    None => {
                        base_map.insert(key, value);
                    }
                }
            }
        }
        (slot, value) => *slot = value,
    }
}

/// 应用 OTS__ 前缀的环境变量覆盖（开发者 Jan），返回实际生效的键值对。
///
/// 前缀后按 __ 分层映射到配置路径（如 OTS__AGENT__MAX_ITERATIONS），
/// 返回生效清单是为了让使用者能核对「我设的变量到底被识别了没有」。
fn apply_env(doc: &mut Value, env: &BTreeMap<String, String>) -> ConfigResult<Vec<(String, String)>> {
    const PREFIX: &str = "OTS__";
    let mut applied = Vec::new();
    for (key, raw) in env {
        let Some(rest) = key.strip_prefix(PREFIX) else {
            continue;
        };
        if rest.is_empty() {
            continue;
        }
        let path: Vec<String> = rest.split("__").map(|segment| segment.to_ascii_lowercase()).collect();
        if path.iter().any(|segment| segment.is_empty()) {
            return Err(ConfigError::Env { key: key.clone(), reason: "路径片段为空，请检查 `__` 分隔符".to_string() });
        }
        set_path(doc, &path, raw).map_err(|reason| ConfigError::Env { key: key.clone(), reason })?;
        applied.push((key.clone(), raw.clone()));
    }
    applied.sort();
    Ok(applied)
}

/// 按路径把字符串写进配置树（开发者 Jan）：逐层下钻，末层按目标已有类型解析取值。
///
/// 环境变量天然都是字符串，这里根据配置里原有的类型做转换（数字 / 布尔 / 数组），
/// 避免把 max_iterations 写成字符串而导致后续反序列化失败。
fn set_path(value: &mut Value, path: &[String], raw: &str) -> Result<(), String> {
    let Some((head, tail)) = path.split_first() else {
        return Err("路径为空".to_string());
    };
    let Value::Object(map) = value else {
        return Err(format!("路径前缀 `{}` 不是对象", head));
    };
    if tail.is_empty() {
        let coerced = coerce(map.get(head), raw);
        map.insert(head.clone(), coerced);
        return Ok(());
    }
    let entry = map.entry(head.clone()).or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    set_path(entry, tail, raw)
}

/// 依据默认配置中同路径的既有类型推导环境变量值的 JSON 类型。
fn coerce(existing: Option<&Value>, raw: &str) -> Value {
    match existing {
        Some(Value::Bool(_)) => match raw.parse::<bool>() {
            Ok(value) => Value::Bool(value),
            Err(_) => Value::String(raw.to_string()),
        },
        Some(Value::Number(number)) if number.is_f64() => match raw.parse::<f64>() {
            Ok(value) => serde_json::json!(value),
            Err(_) => Value::String(raw.to_string()),
        },
        Some(Value::Number(_)) => match raw.parse::<i64>() {
            Ok(value) => serde_json::json!(value),
            Err(_) => Value::String(raw.to_string()),
        },
        Some(Value::Array(_)) => Value::Array(
            raw.split(',')
                .map(|item| Value::String(item.trim().to_string()))
                .filter(|item| item.as_str().is_some_and(|s| !s.is_empty()))
                .collect(),
        ),
        Some(Value::String(_)) => Value::String(raw.to_string()),
        _ => serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string())),
    }
}

/// 将配置渲染为带说明头的 TOML 文本。
///
/// # Errors
/// 序列化失败时返回错误。
pub fn to_toml(config: &OtsConfig) -> ConfigResult<String> {
    let body = toml::to_string_pretty(config).map_err(|err| ConfigError::Toml(err.to_string()))?;
    let header = format!(
        "# ots-cli 配置文件（版本 {}）\n\
         # 生成命令: ots config init\n\
         # 环境变量覆盖格式: OTS__LLM__MODEL=... （`__` 表示层级）\n\n",
        ots_core::VERSION
    );
    Ok(format!("{header}{body}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect()
    }

    #[test]
    fn 环境变量按类型覆盖() {
        let dir = tempfile::tempdir().expect("临时目录");
        let options = LoadOptions::new(dir.path()).with_env(env(&[
            ("OTS__LLM__MODEL", "gpt-4o"),
            ("OTS__AGENT__MAX_ITERATIONS", "12"),
            ("OTS__AGENT__STOP_ON_VERIFICATION_PASS", "false"),
            ("OTS__LLM__MAX_TOKENS", "2048"),
        ]));
        let loaded = load(&options).expect("加载成功");
        assert_eq!(loaded.config.llm.model, "gpt-4o");
        assert_eq!(loaded.config.agent.max_iterations, 12);
        assert!(!loaded.config.agent.stop_on_verification_pass);
        assert_eq!(loaded.config.llm.max_tokens, Some(2048));
    }

    #[test]
    fn 项目级覆盖用户级且命令行优先级最高() {
        let dir = tempfile::tempdir().expect("临时目录");
        let workspace = dir.path();
        fs::create_dir_all(workspace.join(".octopuses")).expect("建目录");
        fs::write(workspace.join(".octopuses/config.toml"), "[llm]\nmodel = \"from-project\"\n").expect("写文件");

        let options = LoadOptions::new(workspace).with_cli_overrides(serde_json::json!({ "llm": { "model": "from-cli" } }));
        let loaded = load(&options).expect("加载成功");
        assert_eq!(loaded.config.llm.model, "from-cli");
    }

    #[test]
    fn 未知字段被拒绝() {
        let dir = tempfile::tempdir().expect("临时目录");
        let path = dir.path().join("bad.toml");
        fs::write(&path, "[llm]\nmodle = \"typo\"\n").expect("写文件");
        let options = LoadOptions::new(dir.path()).with_explicit(&path);
        let err = load(&options).expect_err("应当失败");
        assert!(err.to_string().contains("modle"), "错误信息: {err}");
    }

    #[test]
    fn 默认配置可往返序列化() {
        let text = to_toml(&OtsConfig::default()).expect("序列化");
        let parsed: OtsConfig = toml::from_str(&text).expect("反序列化");
        assert_eq!(parsed, OtsConfig::default());
    }
}
