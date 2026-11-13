//! 工具参数读取助手。
//!
//! 运行时会在调用前用 JSON Schema 校验参数，但工具仍必须对「直接调用」保持健壮，
//! 因此统一通过本模块读取，缺失或类型不符时给出明确的 [`ToolError::Invalid`]。

use ots_core::{ToolContext, ToolError};
use serde_json::Value;
use std::time::Duration;

/// 读取必填字符串。
///
/// # Errors
/// 字段缺失、非字符串或为空白时返回 [`ToolError::Invalid`]。
pub fn required_str(args: &Value, key: &str) -> Result<String, ToolError> {
    let text = required_text(args, key)?;
    if text.trim().is_empty() {
        return Err(ToolError::Invalid(format!("参数 `{key}` 不能为空白字符串")));
    }
    Ok(text)
}

/// 读取必填文本，允许为空字符串（例如把文件内容清空）。
///
/// # Errors
/// 字段缺失或不是字符串时返回 [`ToolError::Invalid`]。
pub fn required_text(args: &Value, key: &str) -> Result<String, ToolError> {
    match args.get(key) {
        Some(Value::String(text)) => Ok(text.clone()),
        Some(_) => Err(ToolError::Invalid(format!("参数 `{key}` 必须是字符串"))),
        None => Err(ToolError::Invalid(format!("缺少必填参数 `{key}`"))),
    }
}

/// 读取选填字符串，空白字符串视为未提供。
///
/// # Errors
/// 字段存在但不是字符串时返回 [`ToolError::Invalid`]。
pub fn optional_str(args: &Value, key: &str) -> Result<Option<String>, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.trim().is_empty() => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(ToolError::Invalid(format!("参数 `{key}` 必须是字符串"))),
    }
}

/// 读取选填正整数。
///
/// # Errors
/// 字段存在但不是正整数时返回 [`ToolError::Invalid`]。
pub fn optional_positive_u64(args: &Value, key: &str) -> Result<Option<u64>, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => match number.as_u64() {
            Some(value) if value > 0 => Ok(Some(value)),
            _ => Err(ToolError::Invalid(format!("参数 `{key}` 必须是大于 0 的整数"))),
        },
        Some(_) => Err(ToolError::Invalid(format!("参数 `{key}` 必须是整数"))),
    }
}

/// 读取选填布尔值。
///
/// # Errors
/// 字段存在但不是布尔值时返回 [`ToolError::Invalid`]。
pub fn optional_bool(args: &Value, key: &str) -> Result<Option<bool>, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(ToolError::Invalid(format!("参数 `{key}` 必须是布尔值"))),
    }
}

/// 解析本次调用的超时：参数优先，但不会超过上下文给定的上限。
///
/// # Errors
/// `timeout_secs` 非正整数时返回 [`ToolError::Invalid`]。
pub fn timeout(arguments: &Value, ctx: &ToolContext) -> Result<Duration, ToolError> {
    Ok(match optional_positive_u64(arguments, "timeout_secs")? {
        Some(secs) => Duration::from_secs(secs).min(ctx.timeout),
        None => ctx.timeout,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 读取必填字符串() {
        assert_eq!(required_str(&json!({"a": "x"}), "a").expect("ok"), "x");
        assert!(required_str(&json!({}), "a").is_err());
        assert!(required_str(&json!({"a": "  "}), "a").is_err());
        assert!(required_str(&json!({"a": 1}), "a").is_err());
    }

    #[test]
    fn 空白选填字符串视为未提供() {
        assert_eq!(optional_str(&json!({"a": ""}), "a").expect("ok"), None);
        assert_eq!(optional_str(&json!({}), "a").expect("ok"), None);
        assert_eq!(optional_str(&json!({"a": "v"}), "a").expect("ok").as_deref(), Some("v"));
    }

    #[test]
    fn 正整数校验() {
        assert_eq!(optional_positive_u64(&json!({"n": 3}), "n").expect("ok"), Some(3));
        assert!(optional_positive_u64(&json!({"n": 0}), "n").is_err());
        assert!(optional_positive_u64(&json!({"n": -1}), "n").is_err());
        assert!(optional_positive_u64(&json!({"n": "x"}), "n").is_err());
    }
}
